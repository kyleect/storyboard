import { z } from "zod";
import {
  defineTool,
  EntryError,
  FileType,
  type ToolOutput,
} from "@harness/core";

/*
 * Files and memory tools (files and memory design, decisions 16 to 20):
 * one tool per operation, none asking for approval by default.
 */

const Scope = z
  .enum(["session", "project", "global"])
  .describe(
    "session: this conversation only. project: every conversation in this project. global: every conversation.",
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
const guarded = (target: Target, run: () => ToolOutput): ToolOutput => {
  try {
    return run();
  } catch (err) {
    if (err instanceof EntryError) return fail(err.message, "rejected", target);
    throw err;
  }
};

const KEY_RULE =
  'Letters, digits, "-", "_" and "." only; case-sensitive (for example characters.alice.md).';

export const filesList = defineTool({
  name: "files_list",
  description:
    "Lists files (keys, types and sizes) in one scope, or in every scope when scope is left out. The same key can exist in several scopes.",
  input: z.object({ scope: Scope.optional() }),
  approval: "never",
  execute: ({ scope }, ctx) =>
    guarded({ scope }, () => ({
      data: { files: ctx.entries.listFiles(scope) },
    })),
});

export const filesRead = defineTool({
  name: "files_read",
  description: "Reads one file's full value.",
  input: z.object({ scope: Scope, key: z.string().describe(KEY_RULE) }),
  approval: "never",
  execute: ({ scope, key }, ctx) =>
    guarded({ scope, key }, () => {
      const file = ctx.entries.readFile(scope, key);
      if (!file)
        return fail(`There is no ${scope} file "${key}".`, "not_found", {
          scope,
          key,
        });
      return {
        data: { scope, key, type: file.type, value: file.value },
      };
    }),
});

export const filesWrite = defineTool({
  name: "files_write",
  description:
    "Creates a file, or replaces its whole value. The user can see and edit files too. type is how the value is shown: plain, markdown or json (json must be valid JSON).",
  input: z.object({
    scope: Scope,
    key: z.string().describe(KEY_RULE),
    type: FileType,
    value: z.string(),
  }),
  approval: "never",
  execute: ({ scope, key, type, value }, ctx) =>
    guarded({ scope, key, type }, () => {
      const created = ctx.entries.writeFile(scope, key, type, value);
      return { data: { scope, key, type, created } };
    }),
});

export const filesDelete = defineTool({
  name: "files_delete",
  description:
    "Deletes a file. Its history is kept, and the user can restore it.",
  input: z.object({ scope: Scope, key: z.string().describe(KEY_RULE) }),
  approval: "never",
  execute: ({ scope, key }, ctx) =>
    guarded({ scope, key }, () =>
      ctx.entries.deleteFile(scope, key)
        ? { data: { scope, key, deleted: true } }
        : fail(`There is no ${scope} file "${key}".`, "not_found", {
            scope,
            key,
          }),
    ),
});

export const memoryList = defineTool({
  name: "memory_list",
  description:
    "Lists your memory notes (ids and text) in one scope, or in every scope when scope is left out.",
  input: z.object({ scope: Scope.optional() }),
  approval: "never",
  execute: ({ scope }, ctx) =>
    guarded({ scope }, () => ({
      data: { notes: ctx.entries.listNotes(scope) },
    })),
});

export const memoryAdd = defineTool({
  name: "memory_add",
  description:
    "Saves a short note for yourself and returns its id. Keep one fact or idea per note.",
  input: z.object({ scope: Scope, text: z.string().min(1) }),
  approval: "never",
  execute: ({ scope, text }, ctx) =>
    guarded({ scope }, () => ({
      data: { scope, id: ctx.entries.addNote(scope, text) },
    })),
});

export const memoryUpdate = defineTool({
  name: "memory_update",
  description: "Replaces the text of one of your memory notes, by id.",
  input: z.object({ scope: Scope, id: z.string(), text: z.string().min(1) }),
  approval: "never",
  execute: ({ scope, id, text }, ctx) =>
    guarded({ scope, id }, () =>
      ctx.entries.updateNote(scope, id, text)
        ? { data: { scope, id, updated: true } }
        : fail(`There is no ${scope} memory note "${id}".`, "not_found", {
            scope,
            id,
          }),
    ),
});

export const memoryDelete = defineTool({
  name: "memory_delete",
  description: "Deletes one of your memory notes, by id.",
  input: z.object({ scope: Scope, id: z.string() }),
  approval: "never",
  execute: ({ scope, id }, ctx) =>
    guarded({ scope, id }, () =>
      ctx.entries.deleteNote(scope, id)
        ? { data: { scope, id, deleted: true } }
        : fail(`There is no ${scope} memory note "${id}".`, "not_found", {
            scope,
            id,
          }),
    ),
});

/** Like `guarded`, for the async search tools. */
const guardedAsync = async (
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

const Query = z
  .string()
  .min(1)
  .describe("Words or a description of what to find.");
/** Plan S3: 1 to 20 results, 5 when left out. */
const Limit = z.number().int().min(1).max(20).optional();

export const filesSearch = defineTool({
  name: "files_search",
  description:
    "Searches files by keywords and by meaning, in one scope or every scope when scope is left out. Returns the best matches with the matching excerpt; read a whole file with files_read.",
  input: z.object({ query: Query, scope: Scope.optional(), limit: Limit }),
  approval: "never",
  execute: ({ query, scope, limit }, ctx) =>
    guardedAsync({ scope }, async () => {
      const result = await ctx.entries.search("file", query, scope, limit ?? 5);
      return {
        data: {
          results: result.hits.map((h) => ({
            scope: h.scope,
            key: h.key,
            excerpt: h.excerpt,
          })),
          ...(result.notice ? { notice: result.notice } : {}),
        },
      };
    }),
});

export const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Searches your memory notes by keywords and by meaning, in one scope or every scope when scope is left out. Returns the best matching notes.",
  input: z.object({ query: Query, scope: Scope.optional(), limit: Limit }),
  approval: "never",
  execute: ({ query, scope, limit }, ctx) =>
    guardedAsync({ scope }, async () => {
      const result = await ctx.entries.search("note", query, scope, limit ?? 5);
      return {
        data: {
          notes: result.hits.map((h) => ({
            scope: h.scope,
            id: h.key,
            text: h.excerpt,
          })),
          ...(result.notice ? { notice: result.notice } : {}),
        },
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
 * The fixed system message about files and memory (design decision 15,
 * wording approved in plan P7).
 */
export function entriesInstruction(inProject: boolean): string {
  return [
    "You can keep information across conversations with two sets of tools.",
    "",
    "Files: named text documents (plain, Markdown or JSON) at three scopes: session (this conversation), project (every conversation in this project) and global (every conversation). The user and you can both write them. Use files_list and files_search to find files and files_read to read them.",
    "",
    "Memory: short notes you write for yourself, at the same scopes. Search memory with memory_search when earlier knowledge could help, and save what is worth remembering with memory_add.",
    "",
    `This conversation is in a project: ${inProject ? "yes" : "no"}.`,
  ].join("\n");
}
