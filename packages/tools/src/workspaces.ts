import { z } from "zod";
import {
  defineTool,
  mediaKindOf,
  plainRef,
  WorkspaceError,
  type ApprovalSubject,
  type ToolContext,
  type ToolOutput,
  type WorkspaceAccess,
  type WorkspaceOptions,
} from "@harness/core";

/*
 * Workspace tools (files unification design, D22 to D36, D39, D47). A
 * workspace is a folder on the user's computer. Reading and listing never ask;
 * every tool that changes something asks for approval, per workspace
 * (`approvalSubject`), and is marked `needsReview`.
 */

const PATH_HELP =
  "A reference, workspace://<id>/path, or just the path inside the workspace when only one is attached. Call workspaces_list for the ids.";

const Path = z.string().describe(PATH_HELP);

const fail = (
  error: string,
  reason: string,
  target: Record<string, string>,
): ToolOutput => ({
  data: { error },
  isError: true,
  details: { reason, ...target },
});

type Located = {
  id: string;
  path: string;
  name: string;
  writable: boolean;
  access: WorkspaceAccess;
};

function where(ctx: ToolContext, text: string): Located | ToolOutput {
  const access = ctx.workspaces;
  if (!access) return fail("This session has no workspaces.", "rejected", {});
  const found = access.locate(text);
  if ("error" in found) {
    return fail(found.error, "not_found", { path: text });
  }
  return {
    id: found.workspace.id,
    path: found.path,
    name: found.workspace.name,
    writable: found.workspace.writable,
    access,
  };
}

const isLocated = (v: Located | ToolOutput): v is Located => "id" in v;

/** The subject an approval is asked and remembered for (D27, D39). */
const subjectOf =
  (pick: (input: never) => string) =>
  (input: unknown, ctx: ToolContext): ApprovalSubject | undefined => {
    const found = ctx.workspaces?.locate(pick(input as never));
    if (!found || "error" in found) return undefined;
    return {
      kind: "workspace",
      id: found.workspace.id,
      label: found.workspace.name,
    };
  };

/**
 * Runs an operation. A path outside the folder is refused, unless the user
 * says this one path is fine (D28): then it runs again with `allowOutside`.
 */
async function run(
  ctx: ToolContext,
  target: Record<string, string>,
  op: (options: WorkspaceOptions) => Promise<ToolOutput>,
): Promise<ToolOutput> {
  try {
    return await op({});
  } catch (err) {
    if (!(err instanceof WorkspaceError)) throw err;
    if (err.code === "outside" && err.target) {
      const answer = await ctx.requestInput({
        title: "Reach outside the workspace?",
        description: `The agent wants to use a path that is not inside the workspace folder:\n${err.target}`,
        fields: [
          {
            name: "allow",
            label: "Allow this path, once",
            kind: "boolean",
            required: true,
            default: false,
          },
        ],
        submitLabel: "Continue",
        skipLabel: "Refuse",
      });
      if (answer.outcome !== "skipped" && answer.answers["allow"] === true) {
        try {
          return await op({ allowOutside: true });
        } catch (again) {
          if (!(again instanceof WorkspaceError)) throw again;
          return fail(again.message, again.code, target);
        }
      }
      return fail(
        `${err.message} The user did not allow it.`,
        "outside",
        target,
      );
    }
    return fail(err.message, err.code, target);
  }
}

const hasWorkspaces = (run: { hasWorkspaces?: boolean }) =>
  run.hasWorkspaces === true;

export const workspacesList = defineTool({
  name: "workspaces_list",
  description:
    "Lists the workspaces (folders on the user's computer) you can use, with their ids and whether you can change them.",
  input: z.object({}),
  approval: "never",
  group: "workspaces",
  available: hasWorkspaces,
  execute: (_input, ctx) => ({
    data: {
      workspaces: (ctx.workspaces?.list() ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        writable: w.writable,
        reference: `workspace://${w.id}/`,
      })),
    },
  }),
});

export const workspaceList = defineTool({
  name: "workspace_list",
  description:
    "Lists the files and folders in a workspace folder, with sizes and modified times. Give a folder reference, such as workspace://<id>/chapters, or workspace://<id>/ for the top. Set recursive to include what is inside the folders.",
  input: z.object({
    folder: z
      .string()
      .describe(
        "A folder reference; workspace://<id>/ lists the top of the workspace.",
      ),
    recursive: z.boolean().optional(),
  }),
  approval: "never",
  group: "workspaces",
  available: hasWorkspaces,
  execute: async ({ folder, recursive }, ctx) => {
    const at = where(ctx, folder);
    if (!isLocated(at)) return at;
    return run(ctx, { folder }, async (o) => {
      const entries = await at.access.listDir(at.id, at.path, {
        ...o,
        ...(recursive ? { recursive } : {}),
      });
      return {
        data: {
          workspace: at.name,
          folder: at.path,
          entries,
          ...(entries.length >= 2000
            ? { guidance: "The list was cut at 2,000 entries." }
            : {}),
        },
      };
    });
  },
});

export const workspaceRead = defineTool({
  name: "workspace_read",
  description:
    "Reads a file in a workspace. Long files come back in parts: the result says how long the file is, and offset and limit (in characters) read other parts. An image or audio file is shown or played to you if the model in use can take it.",
  input: z.object({
    path: Path,
    offset: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional()
      .describe("The first character to read. Default 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe("The most characters to read; the user's cap applies."),
    keep: z
      .boolean()
      .optional()
      .describe(
        "For an image or audio file: true to keep it in view in later turns.",
      ),
  }),
  approval: "never",
  group: "workspaces",
  available: hasWorkspaces,
  execute: async ({ path, offset, limit, keep }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      const read = await at.access.read(at.id, at.path, {
        ...o,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const base = { workspace: at.name, path: at.path };
      if (read.kind === "binary") {
        return {
          data: {
            ...base,
            size: read.size,
            guidance: "This is a binary file, so there is no text to read.",
          },
        };
      }
      if (read.kind === "media") {
        const kind = mediaKindOf(read.mediaType);
        if (!kind) {
          return {
            data: { ...base, guidance: "This file cannot be shown to you." },
          };
        }
        if (ctx.mediaSupport && !ctx.mediaSupport[kind]) {
          return {
            data: {
              ...base,
              mediaType: read.mediaType,
              size: read.size,
              guidance: `The model in use cannot take ${kind} files, so it cannot be read.`,
            },
          };
        }
        return {
          data: {
            ...base,
            mediaType: read.mediaType,
            size: read.size,
            guidance: `This is ${kind === "image" ? "an image" : "an audio file"}. It follows this result.`,
          },
          media: [
            {
              ref: plainRef({
                location: "workspace",
                workspaceId: at.id,
                path: at.path,
              }),
              ...(keep !== undefined ? { keep } : {}),
            },
          ],
        };
      }
      const end = read.offset + [...read.text].length;
      return {
        data: {
          ...base,
          mediaType: read.mediaType,
          text: read.text,
          offset: read.offset,
          length: read.total,
          ...(end < read.total
            ? {
                guidance: `Characters ${read.offset} to ${end} of ${read.total}. Read on with offset ${end}.`,
              }
            : {}),
        },
      };
    });
  },
});

export const workspaceSearch = defineTool({
  name: "workspace_search",
  description:
    "Searches the files in the workspaces by keywords and by meaning, and returns the best matches with a reference and an excerpt. Only the parts the user chose to index are searched; workspace_list and workspace_read reach every file.",
  input: z.object({
    query: z.string().min(1).describe("What to look for."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("The most files to return. Default 8."),
  }),
  approval: "never",
  group: "workspaces",
  available: hasWorkspaces,
  execute: async ({ query, limit }, ctx) => {
    const access = ctx.workspaces;
    if (!access) return fail("This session has no workspaces.", "rejected", {});
    const found = await access.search(query, limit ?? 8, ctx.signal);
    const files = found.indexed.reduce((n, w) => n + w.files, 0);
    return {
      data: {
        hits: found.hits.map((h) => ({
          reference: plainRef({
            location: "workspace",
            workspaceId: h.workspace.id,
            path: h.path,
          }),
          workspace: h.workspace.name,
          excerpt: h.excerpt,
          matched: h.matched,
        })),
        mode: found.mode,
        ...(found.notice ? { notice: found.notice } : {}),
        ...(files === 0
          ? {
              guidance:
                "Nothing in these workspaces is indexed: the user chooses what to search on the Workspaces page. workspace_list and workspace_read still reach every file.",
            }
          : {}),
      },
    };
  },
});

export const workspaceWrite = defineTool({
  name: "workspace_write",
  description:
    "Creates a text file in a writable workspace, or replaces one. A file that exists must have been read with workspace_read first, and is refused if it changed since. Folders on the way are made. Asks the user for approval.",
  input: z.object({
    path: Path,
    content: z.string().describe("The whole new content of the file."),
  }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { path: string }) => i.path),
  execute: async ({ path, content }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      const done = await at.access.write(at.id, at.path, content, o);
      return {
        data: {
          workspace: at.name,
          path: at.path,
          created: done.created,
          size: done.size,
        },
      };
    });
  },
});

export const workspaceEdit = defineTool({
  name: "workspace_edit",
  description:
    "Replaces text in a file of a writable workspace. The file must have been read with workspace_read first, and is refused if it changed since. oldText must match exactly and be in the file once, unless replaceAll is set. Asks the user for approval.",
  input: z.object({
    path: Path,
    oldText: z.string().describe("The text to replace, exactly as it is."),
    newText: z.string().describe("What to put in its place."),
    replaceAll: z.boolean().optional(),
  }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { path: string }) => i.path),
  execute: async ({ path, oldText, newText, replaceAll }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      const done = await at.access.edit(at.id, at.path, oldText, newText, {
        ...o,
        ...(replaceAll ? { replaceAll } : {}),
      });
      return {
        data: {
          workspace: at.name,
          path: at.path,
          replacements: done.replacements,
        },
      };
    });
  },
});

/** The destination of a move, in the same workspace as the source. */
function destination(
  ctx: ToolContext,
  from: Located,
  to: string,
): Located | ToolOutput {
  const found = where(ctx, to);
  if (!isLocated(found)) return found;
  if (found.id !== from.id) {
    return fail("A file cannot be moved to another workspace.", "invalid", {
      to,
    });
  }
  return found;
}

export const workspaceMove = defineTool({
  name: "workspace_move",
  description:
    "Renames or moves a file within a writable workspace. It never replaces a file that exists. Asks the user for approval.",
  input: z.object({
    from: Path,
    to: z.string().describe("The new path, in the same workspace."),
  }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { from: string }) => i.from),
  execute: async ({ from, to }, ctx) => {
    const a = where(ctx, from);
    if (!isLocated(a)) return a;
    const b = destination(ctx, a, to);
    if (!isLocated(b)) return b;
    return run(ctx, { from, to }, async (o) => {
      await a.access.move(a.id, a.path, b.path, o);
      return { data: { workspace: a.name, from: a.path, to: b.path } };
    });
  },
});

export const workspaceDelete = defineTool({
  name: "workspace_delete",
  description:
    "Deletes a file in a writable workspace. It cannot be undone. Asks the user for approval.",
  input: z.object({ path: Path }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { path: string }) => i.path),
  execute: async ({ path }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      await at.access.remove(at.id, at.path, o);
      return { data: { workspace: at.name, deleted: at.path } };
    });
  },
});

export const workspaceFolderCreate = defineTool({
  name: "workspace_folder_create",
  description:
    "Creates a folder (and the folders on the way) in a writable workspace. Asks the user for approval.",
  input: z.object({ path: Path }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { path: string }) => i.path),
  execute: async ({ path }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      const created = await at.access.createFolder(at.id, at.path, o);
      return { data: { workspace: at.name, folder: at.path, created } };
    });
  },
});

export const workspaceFolderRename = defineTool({
  name: "workspace_folder_rename",
  description:
    "Renames or moves a folder, with everything in it, within a writable workspace. It never replaces a folder that exists. Asks the user for approval.",
  input: z.object({
    from: Path,
    to: z.string().describe("The new path, in the same workspace."),
  }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { from: string }) => i.from),
  execute: async ({ from, to }, ctx) => {
    const a = where(ctx, from);
    if (!isLocated(a)) return a;
    const b = destination(ctx, a, to);
    if (!isLocated(b)) return b;
    return run(ctx, { from, to }, async (o) => {
      await a.access.moveFolder(a.id, a.path, b.path, o);
      return { data: { workspace: a.name, from: a.path, to: b.path } };
    });
  },
});

export const workspaceFolderDelete = defineTool({
  name: "workspace_folder_delete",
  description:
    "Deletes a folder in a writable workspace. A folder with files in it needs recursive, which deletes everything in it; this cannot be undone. The workspace's top folder cannot be deleted. Asks the user for approval.",
  input: z.object({
    path: Path,
    recursive: z.boolean().optional(),
  }),
  approval: "ask",
  needsReview: true,
  group: "workspaces",
  available: hasWorkspaces,
  approvalSubject: subjectOf((i: { path: string }) => i.path),
  execute: async ({ path, recursive }, ctx) => {
    const at = where(ctx, path);
    if (!isLocated(at)) return at;
    return run(ctx, { path }, async (o) => {
      const done = await at.access.deleteFolder(at.id, at.path, {
        ...o,
        ...(recursive ? { recursive } : {}),
      });
      return {
        data: { workspace: at.name, deleted: at.path, files: done.files },
      };
    });
  },
});

export const workspaceTools = [
  workspacesList,
  workspaceList,
  workspaceRead,
  workspaceSearch,
  workspaceWrite,
  workspaceEdit,
  workspaceMove,
  workspaceDelete,
  workspaceFolderCreate,
  workspaceFolderRename,
  workspaceFolderDelete,
];
