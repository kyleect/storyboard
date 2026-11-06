import { z } from "zod";
import {
  COPY_LIMIT_MAX,
  defineTool,
  type FileType,
  type Form,
  type ProjectPush,
  type ProjectSummary,
  type Scope,
  type Tool,
  type ToolContext,
  type ToolOutput,
} from "@harness/core";
import { scopeLabel } from "./entries.js";
import { fail, guarded, notDone } from "./results.js";

/*
 * Copy and move for files and memory notes (agent tools design, 3.2).
 *
 * - Within the session's own scopes (session, project, global), any
 *   direction. To another project, only from the session or project scope:
 *   a project can only send (Q6). The destination is a write-only handle, so
 *   nothing in another project can be read (plan Q2).
 * - Every call asks for approval first (the tools always ask), then shows one
 *   form (tool prompts D10) with the model's suggestions preselected (Q8). The
 *   form warns when the suggested destination already has a file with that key
 *   (Q9); a key that is there when the call runs is skipped (bulk conflicts).
 * - A copied note always gets a new id (Q10). A move deletes the original only
 *   for what was copied (point 1).
 */

const SCOPES = ["session", "project", "global"] as const;

const SCOPE_HELP =
  "session: this conversation only. project: every conversation in this project. global: every conversation.";

/** The destination choice for a project other than the session's own. */
const PROJECT_PREFIX = "project:";

type Destination =
  | { kind: "scope"; scope: Scope }
  | { kind: "project"; project: ProjectSummary };

/** What differs between files and notes. */
interface Adapter {
  noun: "file" | "note";
  plural: string;
  /** Keys or ids in a scope. */
  list(ctx: ToolContext, scope: Scope): string[];
  /** The item, undefined when it is not there. */
  read(
    ctx: ToolContext,
    scope: Scope,
    name: string,
  ): { type?: FileType; value: string } | undefined;
  /** Writes into one of the session's scopes; returns the name it has there. */
  writeScope(
    ctx: ToolContext,
    scope: Scope,
    name: string,
    item: { type?: FileType; value: string },
  ): string;
  /** Sends to another project; returns the name it has there. */
  writeProject(
    push: ProjectPush,
    name: string,
    item: { type?: FileType; value: string },
  ): string;
  /** Whether the destination already has the name (files only). */
  hasScope(ctx: ToolContext, scope: Scope, name: string): boolean;
  hasProject(push: ProjectPush, name: string): boolean;
  remove(ctx: ToolContext, scope: Scope, name: string): void;
}

const fileAdapter: Adapter = {
  noun: "file",
  plural: "files",
  list: (ctx, scope) => ctx.entries.listFiles(scope).map((f) => f.key),
  read: (ctx, scope, name) => {
    const file = ctx.entries.readFile(scope, name);
    return file ? { type: file.type, value: file.value } : undefined;
  },
  writeScope: (ctx, scope, name, item) => {
    ctx.entries.writeFile(scope, name, item.type ?? "markdown", item.value);
    return name;
  },
  writeProject: (push, name, item) => {
    push.putFile(name, item.type ?? "markdown", item.value);
    return name;
  },
  hasScope: (ctx, scope, name) =>
    ctx.entries.readFile(scope, name) !== undefined,
  hasProject: (push, name) => push.hasFile(name),
  remove: (ctx, scope, name) => {
    ctx.entries.deleteFile(scope, name);
  },
};

const noteAdapter: Adapter = {
  noun: "note",
  plural: "notes",
  list: (ctx, scope) => ctx.entries.listNotes(scope).map((n) => n.id),
  read: (ctx, scope, name) => {
    const note = ctx.entries.listNotes(scope).find((n) => n.id === name);
    return note ? { value: note.text } : undefined;
  },
  writeScope: (ctx, scope, _name, item) =>
    ctx.entries.addNote(scope, item.value),
  writeProject: (push, _name, item) => push.addNote(item.value),
  // A copied note gets a new id, so it never clashes (Q10).
  hasScope: () => false,
  hasProject: () => false,
  remove: (ctx, scope, name) => {
    ctx.entries.deleteNote(scope, name);
  },
};

interface Input {
  /** Keys or ids. Left out when `all` is true. */
  names: string[] | undefined;
  all: boolean | undefined;
  from: Scope | undefined;
  to: Scope | undefined;
  toProject: string | undefined;
}

const parseDestination = (
  value: string,
  others: readonly ProjectSummary[],
): Destination | undefined => {
  if (value.startsWith(PROJECT_PREFIX)) {
    const id = value.slice(PROJECT_PREFIX.length);
    const project = others.find((p) => p.id === id);
    return project ? { kind: "project", project } : undefined;
  }
  return (SCOPES as readonly string[]).includes(value)
    ? { kind: "scope", scope: value as Scope }
    : undefined;
};

const countText = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Up to a few names for a form, then how many more. */
const some = (names: readonly string[], max = 8): string =>
  names.length <= max
    ? names.join(", ")
    : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;

async function transfer(
  adapter: Adapter,
  move: boolean,
  input: Input,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const verb = move ? "move" : "copy";
  const Verb = move ? "Move" : "Copy";
  const { noun, plural } = adapter;
  const target = {
    from: input.from,
    to: input.to,
    toProject: input.toProject,
  };

  // What to copy: named items, or everything in the scope.
  const names = input.names ? [...new Set(input.names)] : undefined;
  if ((names === undefined) === (input.all !== true)) {
    return fail(
      `Name the ${plural} to ${verb}, or set all to true to ${verb} every ${noun} in the scope. Not both, and not neither.`,
      "rejected",
      target,
    );
  }
  if (names && names.length > ctx.copyLimit) {
    return fail(
      `At most ${ctx.copyLimit} ${plural} can be named in one call (a setting). Split the call, or set all to true.`,
      "rejected",
      target,
    );
  }

  // The destinations: the session's own scopes, and other projects.
  const others = ctx.projects.list().filter((p) => p.id !== ctx.projectId);
  let suggestedTo: string | undefined =
    input.to && ctx.entries.scopes.includes(input.to) ? input.to : undefined;
  if (input.toProject !== undefined) {
    if (input.toProject === ctx.projectId && ctx.projectId !== null) {
      suggestedTo = "project";
    } else if (others.some((p) => p.id === input.toProject)) {
      suggestedTo = `${PROJECT_PREFIX}${input.toProject}`;
    } else {
      return fail(
        `There is no project "${input.toProject}" to send to. Call projects_list.`,
        "not_found",
        target,
      );
    }
  }

  // The source: the suggestion, else the one scope that has everything named.
  const scopes = ctx.entries.scopes;
  let suggestedFrom: Scope | undefined =
    input.from && scopes.includes(input.from) ? input.from : undefined;
  if (suggestedFrom === undefined && names) {
    const holding = scopes.filter((s) => {
      const there = adapter.list(ctx, s);
      return names.every((n) => there.includes(n));
    });
    if (holding.length === 1) suggestedFrom = holding[0];
  }

  // Warn about conflicts at the suggested destination (Q9, files only).
  const warnings: string[] = [];
  if (suggestedFrom && suggestedTo) {
    const dest = parseDestination(suggestedTo, others) ?? {
      kind: "scope" as const,
      scope: suggestedTo as Scope,
    };
    const sourceNames = names ?? adapter.list(ctx, suggestedFrom);
    const push =
      dest.kind === "project" ? ctx.projects.push(dest.project.id) : undefined;
    const clashes = sourceNames.filter((n) =>
      dest.kind === "project" && push
        ? adapter.hasProject(push, n)
        : dest.kind === "scope"
          ? dest.scope !== suggestedFrom && adapter.hasScope(ctx, dest.scope, n)
          : false,
    );
    if (clashes.length > 0) {
      warnings.push(
        `Already in the destination, so they would be skipped: ${some(clashes)}.`,
      );
    }
  }

  const fromLabels = Object.fromEntries(
    scopes.map((s) => [
      s,
      scopeLabel(s, ctx.projectName) +
        (s === suggestedFrom ? " (suggested)" : ""),
    ]),
  );
  const toOptions = [
    ...scopes.map((s) => s as string),
    ...others.map((p) => `${PROJECT_PREFIX}${p.id}`),
  ];
  const toLabels = {
    ...Object.fromEntries(
      scopes.map((s) => [
        s,
        scopeLabel(s, ctx.projectName) +
          (s === suggestedTo ? " (suggested)" : ""),
      ]),
    ),
    ...Object.fromEntries(
      others.map((p) => [
        `${PROJECT_PREFIX}${p.id}`,
        `Another project: ${p.name}${
          `${PROJECT_PREFIX}${p.id}` === suggestedTo ? " (suggested)" : ""
        }`,
      ]),
    ),
  };
  const what = names
    ? `${countText(names.length, noun)}: ${some(names)}`
    : `every ${noun} in the source scope`;
  const form: Form = {
    title: `${Verb} ${plural}`,
    description: [
      `${Verb} ${what}.`,
      move
        ? "The originals are deleted after they are copied."
        : "The originals are kept.",
      "Only session and project entries can be sent to another project.",
      ...warnings,
    ].join(" "),
    fields: [
      {
        name: "from",
        label: "From",
        required: true,
        noOther: true,
        kind: "choice",
        options: [...scopes],
        labels: fromLabels,
        ...(suggestedFrom ? { default: suggestedFrom } : {}),
      },
      {
        name: "to",
        label: "To",
        required: true,
        noOther: true,
        kind: "choice",
        options: toOptions,
        labels: toLabels,
        ...(suggestedTo ? { default: suggestedTo } : {}),
      },
    ],
    submitLabel: Verb,
    skipLabel: `Don't ${verb}`,
  };
  const answer = await ctx.requestInput(form);
  if (answer.outcome === "skipped") {
    return notDone(
      `Not ${move ? "moved" : "copied"}: the user chose not to ${verb} these ${plural}.`,
    );
  }
  const from = String(answer.answers["from"]) as Scope;
  const dest = parseDestination(String(answer.answers["to"]), others);
  if (!dest) {
    return fail("The destination is not available.", "rejected", target);
  }
  if (dest.kind === "scope" && dest.scope === from) {
    return fail(
      `Nothing was ${move ? "moved" : "copied"}: the source and the destination are the same scope.`,
      "rejected",
      target,
    );
  }
  if (dest.kind === "project" && from === "global") {
    return fail(
      `Nothing was ${move ? "moved" : "copied"}: only session and project entries can be sent to another project.`,
      "rejected",
      target,
    );
  }

  const push =
    dest.kind === "project" ? ctx.projects.push(dest.project.id) : undefined;
  const sourceNames = names ?? adapter.list(ctx, from);
  const done: (string | { id: string; newId: string })[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];
  for (const name of sourceNames) {
    const item = adapter.read(ctx, from, name);
    if (!item) {
      notFound.push(name);
      continue;
    }
    const exists =
      dest.kind === "project" && push
        ? adapter.hasProject(push, name)
        : dest.kind === "scope"
          ? adapter.hasScope(ctx, dest.scope, name)
          : false;
    if (exists) {
      skipped.push(name);
      continue;
    }
    const written =
      dest.kind === "project" && push
        ? adapter.writeProject(push, name, item)
        : adapter.writeScope(
            ctx,
            (dest as { kind: "scope"; scope: Scope }).scope,
            name,
            item,
          );
    done.push(noun === "note" ? { id: name, newId: written } : name);
    if (move) adapter.remove(ctx, from, name);
  }

  const notes: string[] = [];
  const chosenTo =
    dest.kind === "project"
      ? `${PROJECT_PREFIX}${dest.project.id}`
      : dest.scope;
  if (suggestedFrom && from !== suggestedFrom) {
    notes.push(
      `The user chose the ${from} scope as the source instead of your suggestion (${suggestedFrom}).`,
    );
  }
  if (suggestedTo && chosenTo !== suggestedTo) {
    notes.push("The user chose a different destination than you suggested.");
  }
  return {
    data: {
      from,
      to:
        dest.kind === "project"
          ? { project: dest.project.name, id: dest.project.id }
          : dest.scope,
      [move ? "moved" : "copied"]: done,
      ...(skipped.length > 0
        ? {
            skipped,
            skippedBecause: `the destination already has a ${noun} with that name`,
          }
        : {}),
      ...(notFound.length > 0 ? { notFound } : {}),
      ...(noun === "note" && done.length > 0
        ? { note: "Each copied note has a new id (newId)." }
        : {}),
      ...(notes.length > 0 ? { userChoice: notes.join(" ") } : {}),
    },
  };
}

const From = z
  .enum(SCOPES)
  .optional()
  .describe(
    `Where you suggest taking them from; the user decides. ${SCOPE_HELP}`,
  );
const To = z
  .enum(SCOPES)
  .optional()
  .describe(
    `Where you suggest putting them, in one of this session's scopes; the user decides. Use toProject for another project.`,
  );
const ToProject = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The id (from projects_list) of another project to send them to. Only session and project entries can be sent.",
  );
const All = z
  .boolean()
  .optional()
  .describe("true: every entry in the source scope, instead of naming them.");

/** The keys or ids a call names; its length is also checked against the setting. */
const names = (what: string) =>
  z
    .array(z.string().min(1))
    .min(1)
    .max(COPY_LIMIT_MAX)
    .optional()
    .describe(
      `The ${what} to name. At most the copy limit (20 unless the user changed it); use all for more.`,
    );

function build(
  adapter: Adapter,
  move: boolean,
  field: "keys" | "ids",
  describe: string,
): Tool {
  const verb = move ? "move" : "copy";
  const schema =
    field === "keys"
      ? z.object({
          keys: names("file keys"),
          all: All,
          from: From,
          to: To,
          toProject: ToProject,
        })
      : z.object({
          ids: names("note ids"),
          all: All,
          from: From,
          to: To,
          toProject: ToProject,
        });
  return defineTool({
    name: `${adapter.noun === "file" ? "files" : "memory"}_${verb}`,
    description: describe,
    input: schema,
    approval: "always",
    group: adapter.noun === "file" ? "files" : "memory",
    execute: (raw, ctx) => {
      const i = raw as {
        keys?: string[];
        ids?: string[];
        all?: boolean;
        from?: Scope;
        to?: Scope;
        toProject?: string;
      };
      return guarded({ from: i.from, to: i.to, toProject: i.toProject }, () =>
        transfer(
          adapter,
          move,
          {
            names: i.keys ?? i.ids,
            all: i.all,
            from: i.from,
            to: i.to,
            toProject: i.toProject,
          },
          ctx,
        ),
      );
    },
  });
}

const COMMON =
  "Name them, or set all to true for every one in the source scope. Suggest where from and to; the user decides in a form. To send them to another project, give its id from projects_list in toProject; only session and project entries can be sent, never pulled from another project. The user must approve each call.";

export const filesCopy = build(
  fileAdapter,
  false,
  "keys",
  `Copies files to another scope or project and keeps the originals. ${COMMON} Files whose key already exists in the destination are skipped.`,
);
export const filesMove = build(
  fileAdapter,
  true,
  "keys",
  `Moves files to another scope or project: copies them, then deletes the originals that were copied. ${COMMON} Files whose key already exists in the destination are skipped and stay where they are.`,
);
export const memoryCopy = build(
  noteAdapter,
  false,
  "ids",
  `Copies memory notes to another scope or project and keeps the originals. ${COMMON} Each copy gets a new id.`,
);
export const memoryMove = build(
  noteAdapter,
  true,
  "ids",
  `Moves memory notes to another scope or project: copies them, then deletes the originals. ${COMMON} Each copy gets a new id.`,
);

export const copyTools = [filesCopy, memoryCopy, filesMove, memoryMove];
