import { z } from "zod";
import {
  checkFileName,
  checkFileValue,
  defineTool,
  FILE_KEY_PATTERN,
  FileError,
  isInFolder,
  mediaKindOf,
  parseRef,
  plainRef,
  TEXT_MEDIA_TYPES,
  type Form,
  type FormField,
  type Scope,
  type ToolContext,
  type ToolOutput,
} from "@harness/core";

/*
 * Files tools (files and memory design, decisions 16 to 20):
 * one tool per operation, none asking for approval by default.
 *
 * Scopes (tool prompts design): the model suggests where a new file goes
 * and the user decides in a form (D1, D2, D15). Reads, updates and deletes
 * find the file by key and ask only when it is in more than one scope
 * (D13, D19). Lists and searches cover every scope unless
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
 * "not_found" for a missing file, "rejected" for an `FileError`
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
    if (err instanceof FileError) return fail(err.message, "rejected", target);
    throw err;
  }
};

/**
 * The result when the user skips a form (D5). An error result, so the
 * model sees nothing was done; the loop does not report it as an error.
 */
const notDone = (text: string): ToolOutput => ({ data: text, isError: true });

const KEY_RULE =
  'A name, or folders and a name separated by "/" (for example characters/alice.md). Case-sensitive. Spaces and any letters are fine; no control characters, no "." or ".." as a name, no name ending in a dot or a space, no Windows device names such as CON or NUL, at most 255 characters per name. You can also give a reference such as <session://notes.md> to name the scope and the file together.';

/**
 * A file named by a reference (`<session://notes.md>` or plain) gives its
 * scope and path; any other text is a path with no scope (D7, D34, D52).
 */
function resolveName(
  ctx: ToolContext,
  text: string,
): { key: string; scope?: Scope } {
  const ref = parseRef(text.trim());
  if (!ref) return { key: text };
  if (ref.location === "workspace") {
    throw new FileError(
      "A workspace file cannot be reached with the files tools.",
    );
  }
  if (!ctx.files.scopes.includes(ref.location)) {
    throw new FileError(
      ref.location === "project"
        ? "This conversation is not in a project, so there is no project scope."
        : `The ${ref.location} scope is not available.`,
    );
  }
  return { key: ref.path, scope: ref.location };
}

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
  const choices = ctx.files.scopes;
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
function overrideGuidance(
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

const RememberedScopes = z.object({ scopes: z.array(z.enum(SCOPES)) });

/** The scopes the user chose to keep using, if any are still available. */
function rememberedScopes(ctx: ToolContext): Scope[] | undefined {
  const parsed = RememberedScopes.safeParse(ctx.state);
  if (!parsed.success) return undefined;
  const kept = ctx.files.scopes.filter((s) => parsed.data.scopes.includes(s));
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
  | { scopes: Scope[]; state?: unknown; guidance?: string | undefined }
  | undefined
> {
  const kept = rememberedScopes(ctx);
  if (kept)
    return { scopes: kept, guidance: overrideGuidance(suggested, kept) };
  const all = ctx.files.scopes;
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
    guidance: overrideGuidance(suggested, asked.scopes),
  };
}

// ---- Finding a file by key or id (D13, D19) ----------------------------

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
  ctx.files
    .listFiles()
    .filter((f) => f.key === key)
    .map((f) => f.scope);

const several = "It is in more than one scope; pick the copy.";

// ---- Files ---------------------------------------------------------------

export const filesList = defineTool({
  name: "files_list",
  description:
    "Lists files (keys, media types and sizes) and folders with the scope each is in. Covers every scope unless you name some in scopes. The same key can exist in several scopes. Give folder to list only what is inside one folder.",
  input: z.object({
    scopes: Scopes.optional(),
    folder: z
      .string()
      .min(1)
      .optional()
      .describe("A folder path; leave out to list everything."),
  }),
  approval: "never",
  group: "files",
  execute: ({ scopes, folder }, ctx) =>
    guarded({ scopes: scopes?.join(","), folder }, async () => {
      const covered = await coveredScopes(ctx, scopes, {
        title: "List files in which scopes?",
        question: "Scopes",
        submitLabel: "List",
        skipLabel: "Don't list",
      });
      if (!covered) return notDone("Not listed: the user chose not to list.");
      const inside = (path: string) =>
        folder === undefined || (path !== folder && isInFolder(path, folder));
      return {
        data: {
          files: ctx.files
            .listFiles(covered.scopes)
            .filter((f) => inside(f.key)),
          folders: ctx.files
            .listFolders(covered.scopes)
            .filter((f) => inside(f.path)),
          ...(covered.guidance ? { guidance: covered.guidance } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const filesRead = defineTool({
  name: "files_read",
  description:
    "Reads one file's full value, by key or by reference. If the key is in more than one scope, the user picks the copy. An image or audio file is shown or played to you instead of returned as text, if the model in use can take it.",
  input: z.object({
    key: z.string().describe(KEY_RULE),
    keep: z
      .boolean()
      .optional()
      .describe(
        "For an image or audio file: true to keep it in view in later turns, not only this one. Leave out unless you will need to look at it again.",
      ),
  }),
  approval: "never",
  group: "files",
  execute: ({ key: given, keep }, ctx) =>
    guarded({ key: given }, async () => {
      const { key, scope: named } = resolveName(ctx, given);
      checkFileName(key);
      const scope = await pickCopy(
        ctx,
        named ? [named] : fileCopies(ctx, key),
        {
          title: `Read which "${key}"?`,
          description: several,
          submitLabel: "Read",
          skipLabel: "Don't read",
        },
      );
      if (scope === "skipped")
        return notDone("Not read: the user chose not to pick a copy.");
      const file =
        scope === "none" ? undefined : ctx.files.readFile(scope, key);
      if (!file || scope === "none")
        return fail(`There is no file "${key}".`, "not_found", { key });
      if (file.blob) {
        const kind = file.mediaType ? mediaKindOf(file.mediaType) : undefined;
        const ref = plainRef({ location: scope, path: key });
        const base = { scope, key, mediaType: file.mediaType, size: file.size };
        if (!kind) {
          return {
            data: {
              ...base,
              guidance: "This is a binary file, so there is no text to read.",
            },
          };
        }
        if (ctx.mediaSupport && !ctx.mediaSupport[kind]) {
          return {
            data: {
              ...base,
              guidance: `The model in use cannot take ${kind} files, so it cannot be read.`,
            },
          };
        }
        return {
          data: {
            ...base,
            guidance: `This is ${kind === "image" ? "an image" : "an audio file"}. It follows this result.`,
          },
          media: [{ ref, ...(keep !== undefined ? { keep } : {}) }],
        };
      }
      return {
        data: { scope, key, mediaType: file.mediaType, value: file.value },
      };
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
  patternMessage: "Control characters are not allowed.",
  ...(suggested ? { default: suggested } : {}),
});

export const filesWrite = defineTool({
  name: "files_write",
  description:
    "Creates a file, or replaces its whole value. Call it as soon as you have the value, and leave out key or scope when you don't know them: for a new file the user is shown a form to name it and pick its scope, with your suggestions filled in. Don't ask the user for these in your reply. A file that already exists in one scope is saved there without asking. The result says the name and scope used. The user can see and edit files too. mediaType is what the value is: text/plain, text/markdown (the default) or application/json (it must be valid JSON). A name may include folders, such as characters/alice.md.",
  input: z.object({
    key: z
      .string()
      .optional()
      .describe(`The file's name, if you have one to suggest. ${KEY_RULE}`),
    mediaType: z.enum(TEXT_MEDIA_TYPES).optional(),
    value: z.string(),
    scope: SuggestedScope.optional(),
  }),
  approval: "never",
  group: "files",
  execute: (
    { key: given, mediaType = "text/markdown", value, scope: asked },
    ctx,
  ) =>
    guarded({ key: given, mediaType, scope: asked }, async () => {
      // A bad value fails before the user is asked. A bad suggested name is
      // shown in the form for the user to fix (Q18).
      checkFileValue(mediaType, value);
      const resolved =
        given === undefined ? undefined : resolveName(ctx, given);
      const key = resolved?.key;
      const scope = resolved?.scope ?? asked;
      const valid = (name: string) => {
        try {
          checkFileName(name);
          return true;
        } catch {
          return false;
        }
      };
      const named = key !== undefined && valid(key) ? key : undefined;
      const copies = named
        ? resolved?.scope
          ? fileCopies(ctx, named).filter((s) => s === resolved.scope)
          : fileCopies(ctx, named)
        : [];
      const [only] = copies;
      const remarks: string[] = [];
      let target: Scope;
      let name: string;
      if (named && copies.length === 1 && only) {
        // Saved where it already is, without asking (D2).
        target = only;
        name = named;
        if (scope && scope !== only)
          remarks.push(
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
        const n = overrideGuidance(scope, target);
        if (n) remarks.push(n);
      } else {
        // A new file: the user names it and picks its scope (Q18, D1).
        const choices = ctx.files.scopes;
        const marked = scope && choices.includes(scope) ? [scope] : [];
        const answer = await ctx.requestInput({
          title: "Save a new file",
          description: `${mediaType} file, ${value.length} characters: ${excerpt(value)}`,
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
        checkFileName(name);
        if (key !== undefined && name !== key)
          remarks.push(
            `The user named the file "${name}" instead of your suggestion ("${key}").`,
          );
        const n = overrideGuidance(scope, target);
        if (n) remarks.push(n);
      }
      const created = ctx.files.writeFile(target, name, mediaType, value);
      // A name the user typed can already exist in the scope picked (Q21).
      if (!created && !(named && copies.length > 0))
        remarks.push(
          `This replaced the existing "${name}" in the ${target} scope.`,
        );
      return {
        data: {
          scope: target,
          key: name,
          mediaType,
          created,
          ...(remarks.length > 0 ? { guidance: remarks.join(" ") } : {}),
        },
      };
    }),
});

export const filesDelete = defineTool({
  name: "files_delete",
  description:
    "Deletes a file, by key or by reference. If the key is in more than one scope, the user picks the copy. Its history is kept, and the user can restore it.",
  input: z.object({ key: z.string().describe(KEY_RULE) }),
  approval: "never",
  group: "files",
  execute: ({ key: given }, ctx) =>
    guarded({ key: given }, async () => {
      const { key, scope: named } = resolveName(ctx, given);
      checkFileName(key);
      const scope = await pickCopy(
        ctx,
        named ? [named] : fileCopies(ctx, key),
        {
          title: `Delete which "${key}"?`,
          description: several,
          submitLabel: "Delete",
          skipLabel: "Don't delete",
        },
      );
      if (scope === "skipped")
        return notDone("Not deleted: the user chose not to pick a copy.");
      if (scope === "none" || !ctx.files.deleteFile(scope, key))
        return fail(`There is no file "${key}".`, "not_found", { key });
      return { data: { scope, key, deleted: true } };
    }),
});

// ---- Folders (D6) -------------------------------------------------------

const folderCopies = (ctx: ToolContext, path: string): Scope[] =>
  ctx.files
    .listFolders()
    .filter((f) => f.path === path)
    .map((f) => f.scope);

const FOLDER_RULE =
  'A folder path: names separated by "/" (for example characters/minor). The same rules as file names. You can also give a reference such as <project://characters>.';

export const filesFolderCreate = defineTool({
  name: "files_folder_create",
  description:
    "Creates an empty folder. A folder is also made by writing a file with folders in its name (characters/alice.md). Leave out scope when you don't know it; the user picks it in a form, with your suggestion filled in.",
  input: z.object({
    path: z.string().describe(FOLDER_RULE),
    scope: SuggestedScope.optional(),
  }),
  approval: "never",
  group: "files",
  execute: ({ path: given, scope: asked }, ctx) =>
    guarded({ path: given, scope: asked }, async () => {
      const { key: path, scope: named } = resolveName(ctx, given);
      checkFileName(path);
      let target: Scope;
      if (named) {
        target = named;
      } else {
        const picked = await askScope(ctx, ctx.files.scopes, asked, {
          title: `Create the folder "${path}" where?`,
          question: "Create in",
          submitLabel: "Create",
          skipLabel: "Don't create",
        });
        if (!picked)
          return notDone("Not created: the user chose not to create it.");
        target = picked.scope;
      }
      const created = ctx.files.createFolder(target, path);
      const guidance = overrideGuidance(asked, target);
      return {
        data: {
          scope: target,
          path,
          created,
          ...(guidance ? { guidance } : {}),
        },
      };
    }),
});

export const filesFolderRename = defineTool({
  name: "files_folder_rename",
  description:
    "Renames or moves a folder, with everything inside it, within its scope. If the folder is in more than one scope, the user picks the copy. The new path must not exist.",
  input: z.object({
    path: z.string().describe(FOLDER_RULE),
    newPath: z.string().describe("The folder's new path. " + FOLDER_RULE),
  }),
  approval: "never",
  group: "files",
  execute: ({ path: given, newPath }, ctx) =>
    guarded({ path: given, newPath }, async () => {
      const { key: path, scope: named } = resolveName(ctx, given);
      checkFileName(path);
      const scope = await pickCopy(
        ctx,
        named ? [named] : folderCopies(ctx, path),
        {
          title: `Rename which folder "${path}"?`,
          description: several,
          submitLabel: "Rename",
          skipLabel: "Don't rename",
        },
      );
      if (scope === "skipped")
        return notDone("Not renamed: the user chose not to pick a copy.");
      const moved =
        scope === "none"
          ? undefined
          : ctx.files.renameFolder(scope, path, resolveName(ctx, newPath).key);
      if (!moved)
        return fail(`There is no folder "${path}".`, "not_found", { path });
      return {
        data: { scope, path, newPath, renamed: true, files: moved.files },
      };
    }),
});

export const filesFolderDelete = defineTool({
  name: "files_folder_delete",
  description:
    "Deletes a folder and every file and folder inside it. If the folder is in more than one scope, the user picks the copy. Each deleted file keeps its history, and the user can restore it.",
  input: z.object({ path: z.string().describe(FOLDER_RULE) }),
  approval: "never",
  group: "files",
  execute: ({ path: given }, ctx) =>
    guarded({ path: given }, async () => {
      const { key: path, scope: named } = resolveName(ctx, given);
      checkFileName(path);
      const scope = await pickCopy(
        ctx,
        named ? [named] : folderCopies(ctx, path),
        {
          title: `Delete which folder "${path}"?`,
          description: several,
          submitLabel: "Delete",
          skipLabel: "Don't delete",
        },
      );
      if (scope === "skipped")
        return notDone("Not deleted: the user chose not to pick a copy.");
      const gone =
        scope === "none" ? undefined : ctx.files.deleteFolder(scope, path);
      if (!gone)
        return fail(`There is no folder "${path}".`, "not_found", { path });
      return { data: { scope, path, deleted: true, files: gone.files } };
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
export const filesSearch = defineTool({
  name: "files_search",
  description:
    "Searches files by keywords and by meaning. Covers every scope unless you name some in scopes. Returns the best matches with the scope and the matching excerpt; read a whole file with files_read.",
  input: z.object({ query: Query, scopes: Scopes.optional(), limit: Limit }),
  approval: "never",
  group: "files",
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
      const result = await ctx.files.search(query, covered.scopes, limit ?? 5);
      return {
        data: {
          results: result.hits.map((h) => ({
            scope: h.scope,
            key: h.key,
            excerpt: h.excerpt,
          })),
          ...(result.notice ? { notice: result.notice } : {}),
          ...(covered.guidance ? { guidance: covered.guidance } : {}),
        },
        ...(covered.state ? { state: covered.state } : {}),
      };
    }),
});

export const fileTools = [
  filesList,
  filesRead,
  filesWrite,
  filesDelete,
  filesFolderCreate,
  filesFolderRename,
  filesFolderDelete,
  filesSearch,
];

/**
 * The fixed system message about files (design decision 15;
 * scope wording from tool prompts D17).
 */
export function filesInstruction(inProject: boolean): string {
  return [
    "You can keep information across conversations in files.",
    "",
    "Files: named text documents (plain text, Markdown or JSON), kept in folders. The user and you can both write them. Use files_list and files_search to find files and files_read to read them. A file is named by its path in a scope, and written in text as a reference in angle brackets, such as <session://notes.md> or <project://characters/alice.md>; the tools accept a reference or a plain name.",
    "",
    "Files are kept at three scopes: session (this conversation), project (every conversation in this project) and global (every conversation). To save something new, call the tool right away with your suggestions and leave out what you don't know, such as a file's name or scope; the user fills in or changes them in a form, and the result says what was used. Don't ask the user for them in your reply. Lists and searches cover every scope unless you name some, and the user can change the scopes you name.",
    "",
    "To copy files to another scope, call files_copy; files_move also deletes the originals. Suggest where from and to and the user decides in a form, and each call needs the user's approval. To send files to another project, give its id from projects_list. A project can only send to another project, never pull from one.",
    "",
    `This conversation is in a project: ${inProject ? "yes" : "no"}.`,
  ].join("\n");
}
