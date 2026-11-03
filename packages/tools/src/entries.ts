import { z } from "zod";
import {
  checkFileKey,
  checkFileValue,
  defineTool,
  FILE_KEY_PATTERN,
  EntryError,
  FileType,
  type Form,
  type FormField,
  type Scope,
  type ToolContext,
  type ToolOutput,
} from "@harness/core";

/*
 * Files and memory tools (files and memory design, decisions 16 to 20):
 * one tool per operation, none asking for approval by default.
 *
 * Scopes (tool prompts design): the model suggests where a new file or
 * note goes and the user decides in a form (D1, D2, D15). Reads, updates
 * and deletes find the entry by key or id and ask only when it is in more
 * than one scope (D13, D19). Lists and searches cover every scope unless
 * the model narrows them, and then the user confirms or changes the scopes
 * (D7). The result says when the user overrode the model's suggestion (D11).
 */

const SCOPES = ["session", "project", "global"] as const;

const SCOPE_HELP =
  "session: this conversation only. project: every conversation in this project. global: every conversation.";

/** A scope the model suggests for something new; the user decides. */
const SuggestedScope = z
  .enum(SCOPES)
  .describe(`Where you suggest saving it. ${SCOPE_HELP} The user decides.`);

/** Scopes the model may name to narrow a list or search. */
const Scopes = z
  .array(z.enum(SCOPES))
  .min(1)
  .max(3)
  .describe(
    `Leave out to cover every scope. Name scopes only to narrow it; the user confirms or changes them. ${SCOPE_HELP}`,
  );

/** What a call was about, for error details. */
type Target = Record<string, string | undefined>;

/**
 * Why a call failed, for the errors console (error reporting plan, P3):
 * "not_found" for a missing file or note, "rejected" for an `EntryError`
 * (a bad key, a missing project scope, invalid JSON).
 */
type Reason = "not_found" | "rejected";

const fail = (error: string, reason: Reason, target: Target): ToolOutput => ({
  data: { error },
  isError: true,
  details: {
    reason,
    ...Object.fromEntries(
      Object.entries(target).filter(([, v]) => v !== undefined),
    ),
  },
});

/** Bad keys, a missing project scope and invalid JSON become error results. */
const guarded = async (
  target: Target,
  run: () => Promise<ToolOutput>,
): Promise<ToolOutput> => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof EntryError) return fail(err.message, "rejected", target);
    throw err;
  }
};

/**
 * The result when the user skips a form (D5). An error result, so the
 * model sees nothing was done; the loop does not report it as an error.
 */
const notDone = (text: string): ToolOutput => ({ data: text, isError: true });

const KEY_RULE =
  'Letters, digits, "-", "_" and "." only; case-sensitive (for example characters.alice.md).';
const FILE_KEY = new RegExp(FILE_KEY_PATTERN);

// ---- Forms ---------------------------------------------------------------

/** How a scope is shown in a form (D6). */
export function scopeLabel(scope: Scope, projectName: string | null): string {
  switch (scope) {
    case "session":
      return "session";
    case "project":
      return projectName ? `project (${projectName})` : "project";
    case "global":
      return "global";
  }
}

/** Option labels, with the model's suggestions marked (D6). */
const labelsFor = (
  ctx: ToolContext,
  choices: readonly Scope[],
  suggested: readonly Scope[],
): Record<string, string> =>
  Object.fromEntries(
    choices.map((s) => [
      s,
      scopeLabel(s, ctx.projectName) +
        (suggested.includes(s) ? " (suggested)" : ""),
    ]),
  );

/** The "remember this" question; always answered (a checkbox). */
const rememberField = (label: string): FormField => ({
  name: "remember",
  label,
  required: false,
  noOther: true,
  kind: "boolean",
  default: false,
});

interface Texts {
  title: string;
  description?: string;
  question: string;
  submitLabel: string;
  skipLabel: string;
  /** The "remember this" question; left out: none. */
  remember?: string;
}

/**
 * Asks for one scope out of `choices`, the suggestion preselected when it
 * is one of them (D1, D19). Undefined when the user skips.
 */
async function askScope(
  ctx: ToolContext,
  choices: readonly Scope[],
  suggested: Scope | undefined,
  texts: Texts,
): Promise<{ scope: Scope; remember: boolean } | undefined> {
  const marked = suggested && choices.includes(suggested) ? [suggested] : [];
  const form: Form = {
    title: texts.title,
    ...(texts.description ? { description: texts.description } : {}),
    fields: [
      {
        name: "scope",
        label: texts.question,
        required: true,
        noOther: true,
        kind: "choice",
        options: [...choices],
        labels: labelsFor(ctx, choices, marked),
        ...(marked[0] ? { default: marked[0] } : {}),
      },
      ...(texts.remember ? [rememberField(texts.remember)] : []),
    ],
    submitLabel: texts.submitLabel,
    skipLabel: texts.skipLabel,
  };
  const answer = await ctx.requestInput(form);
  if (answer.outcome === "skipped") return undefined;
  return {
    scope: answer.answers["scope"] as Scope,
    remember: answer.answers["remember"] === true,
  };
}

/** Asks for one or more scopes, the suggestions preselected (D7). */
async function askScopes(
  ctx: ToolContext,
  suggested: readonly Scope[],
  texts: Texts,
): Promise<{ scopes: Scope[]; remember: boolean } | undefined> {
  const choices = ctx.entries.scopes;
  const marked = choices.filter((s) => suggested.includes(s));
  const form: Form = {
    title: texts.title,
    ...(texts.description ? { description: texts.description } : {}),
    fields: [
      {
        name: "scopes",
        label: texts.question,
        required: true,
        noOther: true,
        kind: "multi",
        options: [...choices],
        labels: labelsFor(ctx, choices, marked),
        default: marked,
      },
      ...(texts.remember ? [rememberField(texts.remember)] : []),
    ],
    submitLabel: texts.submitLabel,
    skipLabel: texts.skipLabel,
  };
  const answer = await ctx.requestInput(form);
  if (answer.outcome === "skipped") return undefined;
  const picked = answer.answers["scopes"] as Scope[];
  return {
    scopes: choices.filter((s) => picked.includes(s)),
    remember: answer.answers["remember"] === true,
  };
}

const listText = (scopes: readonly Scope[]) => scopes.join(", ");

/** Said to the model when the user overrode its suggestion (D11). */
function overrideNote(
  suggested: Scope | readonly Scope[] | undefined,
  chosen: Scope | readonly Scope[],
): string | undefined {
  if (suggested === undefined) return undefined;
  const s = typeof suggested === "string" ? [suggested] : suggested;
  const c = typeof chosen === "string" ? [chosen] : chosen;
  const same = s.length === c.length && s.every((x) => c.includes(x));
  if (same) return undefined;
  return typeof chosen === "string"
    ? `The user chose the ${chosen} scope instead of your suggestion (${listText(s)}).`
    : `The user chose ${listText(c)} instead of your suggestion (${listText(s)}).`;
}

/** Up to `n` characters of a value, on one line, for a form (D14). */
const excerpt = (value: string, n = 200) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n)}…` : line;
};

// ---- Remembered scopes (D15, D7) -----------------------------------------

const RememberedScope = z.object({ scope: z.enum(SCOPES) });
const RememberedScopes = z.object({ scopes: z.array(z.enum(SCOPES)) });

/** The scope the user chose to keep using, if it is still available. */
function rememberedScope(ctx: ToolContext): Scope | undefined {
  const parsed = RememberedScope.safeParse(ctx.state);
  return parsed.success && ctx.entries.scopes.includes(parsed.data.scope)
    ? parsed.data.scope
    : undefined;
}

/** The scopes the user chose to keep using, if any are still available. */
function rememberedScopes(ctx: ToolContext): Scope[] | undefined {
  const parsed = RememberedScopes.safeParse(ctx.state);
  if (!parsed.success) return undefined;
  const kept = ctx.entries.scopes.filter((s) => parsed.data.scopes.includes(s));
  return kept.length > 0 ? kept : undefined;
}

/**
 * The scopes a list or search covers (D7): the ones the user chose to keep
 * using; else every scope when the model names none, or all of them; else
 * the user confirms or changes the model's. Undefined when the user skips.
 */
async function coveredScopes(
  ctx: ToolContext,
  suggested: readonly Scope[] | undefined,
  texts: Omit<Texts, "remember">,
): Promise<
  { scopes: Scope[]; state?: unknown; note?: string | undefined } | undefined
> {
  const kept = rememberedScopes(ctx);
  if (kept) return { scopes: kept, note: overrideNote(suggested, kept) };
  const all = ctx.entries.scopes;
  if (suggested === undefined || all.every((s) => suggested.includes(s))) {
    return { scopes: [...all] };
  }
  const asked = await askScopes(ctx, suggested, {
    ...texts,
    remember: "Use these scopes for the rest of this session",
  });
  if (!asked) return undefined;
  return {
    scopes: asked.scopes,
    ...(asked.remember ? { state: { scopes: asked.scopes } } : {}),
    note: overrideNote(suggested, asked.scopes),
  };
}

// ---- Finding an entry by key or id (D13, D19) ----------------------------

/**
 * The scope of the one copy to use: the only one, or the one the user
 * picks when there are several. "none" when there is no copy; "skipped"
 * when the user skips.
 */
async function pickCopy(
  ctx: ToolContext,
  copies: readonly Scope[],
  texts: Omit<Texts, "remember" | "question">,
): Promise<Scope | "none" | "skipped"> {
  const [first] = copies;
  if (first === undefined) return "none";
  if (copies.length === 1) return first;
  const asked = await askScope(ctx, copies, undefined, {
    ...texts,
    question: "Copy",
  });
  return asked ? asked.scope : "skipped";
}

const fileCopies = (ctx: ToolContext, key: string): Scope[] =>
  ctx.entries
    .listFiles()
    .filter((f) => f.key === key)
    .map((f) => f.scope);

const noteCopies = (ctx: ToolContext, id: string): Scope[] =>
  ctx.entries
    .listNotes()
    .filter((n) => n.id === id)
    .map((n) => n.scope);

const several = "It is in more than one scope; pick the copy.";

// ---- Files ---------------------------------------------------------------

export const filesList = defineTool({
  name: "files_list",
  description:
    "Lists files (keys, types and sizes) with the scope each is in. Covers every scope unless you name some in scopes. The same key can exist in several scopes.",
  input: z.object({ scopes: Scopes.optional() }),
  approval: "never",
  execute: ({ scopes }, ctx) =>
    guarded({ scopes: scopes?.join(",") }, async () => {
      const covered = await coveredScopes(ctx, scopes, {
        title: "List files in which scopes?",
        question: "Scopes",
        submitLabel: "List",
        skipLabel: "Don't list",
      });
      if (!covered) return notDone("Not listed: the user chose not to list.");
      return {
        data: {
          files: ctx.entries.listFiles(covered.scopes),
          ...(covered.note ? { note: covered.note } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const filesRead = defineTool({
  name: "files_read",
  description:
    "Reads one file's full value, by key. If the key is in more than one scope, the user picks the copy.",
  input: z.object({ key: z.string().describe(KEY_RULE) }),
  approval: "never",
  execute: ({ key }, ctx) =>
    guarded({ key }, async () => {
      checkFileKey(key);
      const scope = await pickCopy(ctx, fileCopies(ctx, key), {
        title: `Read which "${key}"?`,
        description: several,
        submitLabel: "Read",
        skipLabel: "Don't read",
      });
      if (scope === "skipped")
        return notDone("Not read: the user chose not to pick a copy.");
      const file =
        scope === "none" ? undefined : ctx.entries.readFile(scope, key);
      if (!file)
        return fail(`There is no file "${key}".`, "not_found", { key });
      return { data: { scope, key, type: file.type, value: file.value } };
    }),
});

/** The question for a new file's name (tool prompts Q18, Q20). */
const nameField = (suggested: string | undefined): FormField => ({
  name: "name",
  label: "Name",
  help: KEY_RULE,
  required: true,
  kind: "text",
  multiline: false,
  pattern: FILE_KEY_PATTERN,
  patternMessage: 'Use only letters, digits, "-", "_" and ".".',
  ...(suggested ? { default: suggested } : {}),
});

export const filesWrite = defineTool({
  name: "files_write",
  description:
    "Creates a file, or replaces its whole value. Call it as soon as you have the value, and leave out key or scope when you don't know them: for a new file the user is shown a form to name it and pick its scope, with your suggestions filled in. Don't ask the user for these in your reply. A file that already exists in one scope is saved there without asking. The result says the name and scope used. The user can see and edit files too. type is how the value is shown: plain, markdown (the default) or json (json must be valid JSON).",
  input: z.object({
    key: z
      .string()
      .optional()
      .describe(`The file's name, if you have one to suggest. ${KEY_RULE}`),
    type: FileType.optional(),
    value: z.string(),
    scope: SuggestedScope.optional(),
  }),
  approval: "never",
  execute: ({ key, type = "markdown", value, scope }, ctx) =>
    guarded({ key, type, scope }, async () => {
      // A bad value fails before the user is asked. A bad suggested name is
      // shown in the form for the user to fix (Q18).
      checkFileValue(type, value);
      const named = key !== undefined && FILE_KEY.test(key) ? key : undefined;
      const copies = named ? fileCopies(ctx, named) : [];
      const [only] = copies;
      const notes: string[] = [];
      let target: Scope;
      let name: string;
      if (named && copies.length === 1 && only) {
        // Saved where it already is, without asking (D2).
        target = only;
        name = named;
        if (scope && scope !== only)
          notes.push(
            `"${named}" already exists in the ${only} scope, so it was saved there.`,
          );
      } else if (named && copies.length > 1) {
        const asked = await askScope(ctx, copies, scope, {
          title: `Replace which "${named}"?`,
          description: several,
          question: "Copy",
          submitLabel: "Save",
          skipLabel: "Don't save",
        });
        if (!asked)
          return notDone("Not saved: the user chose not to save this file.");
        target = asked.scope;
        name = named;
        const n = overrideNote(scope, target);
        if (n) notes.push(n);
      } else {
        // A new file: the user names it and picks its scope (Q18, D1).
        const choices = ctx.entries.scopes;
        const marked = scope && choices.includes(scope) ? [scope] : [];
        const answer = await ctx.requestInput({
          title: "Save a new file",
          description: `${type} file, ${value.length} characters: ${excerpt(value)}`,
          fields: [
            nameField(key),
            {
              name: "scope",
              label: "Save to",
              required: true,
              noOther: true,
              kind: "choice",
              options: [...choices],
              labels: labelsFor(ctx, choices, marked),
              ...(marked[0] ? { default: marked[0] } : {}),
            },
          ],
          submitLabel: "Save",
          skipLabel: "Don't save",
        });
        if (answer.outcome === "skipped")
          return notDone("Not saved: the user chose not to save this file.");
        name = String(answer.answers["name"]);
        target = answer.answers["scope"] as Scope;
        checkFileKey(name);
        if (key !== undefined && name !== key)
          notes.push(
            `The user named the file "${name}" instead of your suggestion ("${key}").`,
          );
        const n = overrideNote(scope, target);
        if (n) notes.push(n);
      }
      const created = ctx.entries.writeFile(target, name, type, value);
      // A name the user typed can already exist in the scope picked (Q21).
      if (!created && !(named && copies.length > 0))
        notes.push(
          `This replaced the existing "${name}" in the ${target} scope.`,
        );
      return {
        data: {
          scope: target,
          key: name,
          type,
          created,
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        },
      };
    }),
});

export const filesDelete = defineTool({
  name: "files_delete",
  description:
    "Deletes a file, by key. If the key is in more than one scope, the user picks the copy. Its history is kept, and the user can restore it.",
  input: z.object({ key: z.string().describe(KEY_RULE) }),
  approval: "never",
  execute: ({ key }, ctx) =>
    guarded({ key }, async () => {
      checkFileKey(key);
      const scope = await pickCopy(ctx, fileCopies(ctx, key), {
        title: `Delete which "${key}"?`,
        description: several,
        submitLabel: "Delete",
        skipLabel: "Don't delete",
      });
      if (scope === "skipped")
        return notDone("Not deleted: the user chose not to pick a copy.");
      if (scope === "none" || !ctx.entries.deleteFile(scope, key))
        return fail(`There is no file "${key}".`, "not_found", { key });
      return { data: { scope, key, deleted: true } };
    }),
});

// ---- Memory --------------------------------------------------------------

export const memoryList = defineTool({
  name: "memory_list",
  description:
    "Lists your memory notes (ids, text and scope). Covers every scope unless you name some in scopes.",
  input: z.object({ scopes: Scopes.optional() }),
  approval: "never",
  execute: ({ scopes }, ctx) =>
    guarded({ scopes: scopes?.join(",") }, async () => {
      const covered = await coveredScopes(ctx, scopes, {
        title: "List notes in which scopes?",
        question: "Scopes",
        submitLabel: "List",
        skipLabel: "Don't list",
      });
      if (!covered) return notDone("Not listed: the user chose not to list.");
      return {
        data: {
          notes: ctx.entries.listNotes(covered.scopes),
          ...(covered.note ? { note: covered.note } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const memoryAdd = defineTool({
  name: "memory_add",
  description:
    "Saves a short note for yourself and returns its id and scope. Keep one fact or idea per note. Suggest a scope; the user decides where it is saved.",
  input: z.object({
    text: z.string().min(1),
    scope: SuggestedScope.optional(),
  }),
  approval: "never",
  execute: ({ text, scope }, ctx) =>
    guarded({ scope }, async () => {
      // The scope the user chose to keep using for notes (D15).
      const kept = rememberedScope(ctx);
      let target: Scope;
      let state: unknown;
      if (kept) {
        target = kept;
      } else {
        const asked = await askScope(ctx, ctx.entries.scopes, scope, {
          title: "Save this note where?",
          description: text,
          question: "Save to",
          submitLabel: "Save",
          skipLabel: "Don't save",
          remember: "Use this for my notes for the rest of this session",
        });
        if (!asked)
          return notDone("Not saved: the user chose not to save this note.");
        target = asked.scope;
        if (asked.remember) state = { scope: target };
      }
      const note = overrideNote(scope, target);
      return {
        data: {
          scope: target,
          id: ctx.entries.addNote(target, text),
          ...(note ? { note } : {}),
        },
        ...(state !== undefined ? { state } : {}),
      };
    }),
});

export const memoryUpdate = defineTool({
  name: "memory_update",
  description: "Replaces the text of one of your memory notes, by id.",
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  approval: "never",
  execute: ({ id, text }, ctx) =>
    guarded({ id }, async () => {
      const scope = await pickCopy(ctx, noteCopies(ctx, id), {
        title: `Change which note "${id}"?`,
        description: several,
        submitLabel: "Change",
        skipLabel: "Don't change",
      });
      if (scope === "skipped")
        return notDone("Not changed: the user chose not to pick a copy.");
      if (scope === "none" || !ctx.entries.updateNote(scope, id, text))
        return fail(`There is no memory note "${id}".`, "not_found", { id });
      return { data: { scope, id, updated: true } };
    }),
});

export const memoryDelete = defineTool({
  name: "memory_delete",
  description: "Deletes one of your memory notes, by id.",
  input: z.object({ id: z.string() }),
  approval: "never",
  execute: ({ id }, ctx) =>
    guarded({ id }, async () => {
      const scope = await pickCopy(ctx, noteCopies(ctx, id), {
        title: `Delete which note "${id}"?`,
        description: several,
        submitLabel: "Delete",
        skipLabel: "Don't delete",
      });
      if (scope === "skipped")
        return notDone("Not deleted: the user chose not to pick a copy.");
      if (scope === "none" || !ctx.entries.deleteNote(scope, id))
        return fail(`There is no memory note "${id}".`, "not_found", { id });
      return { data: { scope, id, deleted: true } };
    }),
});

// ---- Search --------------------------------------------------------------

const Query = z
  .string()
  .min(1)
  .describe("Words or a description of what to find.");
/** Plan S3: 1 to 20 results, 5 when left out. */
const Limit = z
  .number()
  .int()
  .min(1)
  .max(20)
  .optional()
  .describe("How many results to return, 1 to 20. Defaults to 5.");
/** Notes are short, so every match comes back unless a limit is given. */
const NoteLimit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("Most notes to return, 1 to 100. Leave out to get every match.");

export const filesSearch = defineTool({
  name: "files_search",
  description:
    "Searches files by keywords and by meaning. Covers every scope unless you name some in scopes. Returns the best matches with the scope and the matching excerpt; read a whole file with files_read.",
  input: z.object({ query: Query, scopes: Scopes.optional(), limit: Limit }),
  approval: "never",
  execute: ({ query, scopes, limit }, ctx) =>
    guarded({ scopes: scopes?.join(",") }, async () => {
      const covered = await coveredScopes(ctx, scopes, {
        title: `Search files for "${excerpt(query, 80)}" in which scopes?`,
        question: "Scopes",
        submitLabel: "Search",
        skipLabel: "Don't search",
      });
      if (!covered)
        return notDone("Not searched: the user chose not to search.");
      const result = await ctx.entries.search(
        "file",
        query,
        covered.scopes,
        limit ?? 5,
      );
      return {
        data: {
          results: result.hits.map((h) => ({
            scope: h.scope,
            key: h.key,
            excerpt: h.excerpt,
          })),
          ...(result.notice ? { notice: result.notice } : {}),
          ...(covered.note ? { note: covered.note } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Searches your memory notes by keywords and by meaning. Covers every scope unless you name some in scopes. Returns every matching note with its scope, best first.",
  input: z.object({
    query: Query,
    scopes: Scopes.optional(),
    limit: NoteLimit,
  }),
  approval: "never",
  execute: ({ query, scopes, limit }, ctx) =>
    guarded({ scopes: scopes?.join(",") }, async () => {
      const covered = await coveredScopes(ctx, scopes, {
        title: `Search notes for "${excerpt(query, 80)}" in which scopes?`,
        question: "Scopes",
        submitLabel: "Search",
        skipLabel: "Don't search",
      });
      if (!covered)
        return notDone("Not searched: the user chose not to search.");
      const result = await ctx.entries.search(
        "note",
        query,
        covered.scopes,
        limit,
      );
      return {
        data: {
          notes: result.hits.map((h) => ({
            scope: h.scope,
            id: h.key,
            text: h.excerpt,
          })),
          ...(result.notice ? { notice: result.notice } : {}),
          ...(covered.note ? { note: covered.note } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const entryTools = [
  filesList,
  filesRead,
  filesWrite,
  filesDelete,
  filesSearch,
  memoryList,
  memoryAdd,
  memoryUpdate,
  memoryDelete,
  memorySearch,
];

/**
 * The fixed system message about files and memory (design decision 15;
 * scope wording from tool prompts D17).
 */
export function entriesInstruction(inProject: boolean): string {
  return [
    "You can keep information across conversations with two sets of tools.",
    "",
    "Files: named text documents (plain, Markdown or JSON). The user and you can both write them. Use files_list and files_search to find files and files_read to read them.",
    "",
    "Memory: short notes you write for yourself. Search memory with memory_search when earlier knowledge could help, and save what is worth remembering with memory_add.",
    "",
    "Both are kept at three scopes: session (this conversation), project (every conversation in this project) and global (every conversation). To save something new, call the tool right away with your suggestions and leave out what you don't know, such as a file's name or scope; the user fills in or changes them in a form, and the result says what was used. Don't ask the user for them in your reply. Lists and searches cover every scope unless you name some, and the user can change the scopes you name.",
    "",
    "To copy entries to another scope, call files_copy or memory_copy; files_move and memory_move also delete the originals. Suggest where from and to and the user decides in a form, and each call needs the user's approval. To send entries to another project, give its id from projects_list. A project can only send to another project, never pull from one.",
    "",
    `This conversation is in a project: ${inProject ? "yes" : "no"}.`,
  ].join("\n");
}
