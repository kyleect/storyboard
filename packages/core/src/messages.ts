import { z } from "zod";
import { PromptRecord } from "./forms.js";

/** Token usage reported by the model server for one response. */
export const Usage = z.object({
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
});
export type Usage = z.infer<typeof Usage>;

/** Per-token data from llama-server's native `/completion` (optional). */
export const TokenInfo = z.object({
  id: z.number().int(),
  text: z.string(),
  logprob: z.number().optional(),
  top: z
    .array(
      z.object({
        id: z.number().int(),
        text: z.string(),
        logprob: z.number(),
      }),
    )
    .optional(),
});
export type TokenInfo = z.infer<typeof TokenInfo>;

export const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ReasoningBlock = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
});

export const ToolCallBlock = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  /**
   * Parsed arguments. In an agent loop, a call whose arguments were not
   * valid JSON keeps the raw string here, so it can be returned to the model
   * with an error result.
   */
  arguments: z.unknown(),
});

export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ReasoningBlock,
  ToolCallBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const SystemMessage = z.object({
  role: z.literal("system"),
  content: z.string(),
});

/**
 * Where a user message came from, for labels in the app. Not sent to the
 * model. Left out on messages saved before this field existed.
 * - `task`: the task a parent agent gave a subagent.
 * - `reminder`: the loop reminded a subagent to hand back.
 * - `user`: the user typed it into a running subagent's panel.
 */
export const UserMessageSource = z.enum(["task", "reminder", "user"]);
export type UserMessageSource = z.infer<typeof UserMessageSource>;

/** The kinds of media a model can be given. */
export const MediaKind = z.enum(["image", "audio"]);
export type MediaKind = z.infer<typeof MediaKind>;

export const UserMessage = z.object({
  role: z.literal("user"),
  content: z.string(),
  /**
   * References to the files sent with the text (files unification design,
   * D10), such as `session://photo.png`. Kind, type and size are looked up
   * from each file when a request is made (see `ChatRequest.resolveFile`).
   * Left out when there are none.
   */
  files: z.array(z.string()).optional(),
  source: UserMessageSource.optional(),
});

export const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.array(ContentBlock),
});

/** The media types of text files; their value is the text itself. */
export const TEXT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
] as const;

/**
 * The media types of binary files: the formats llama-server reads (files
 * unification design, D4). The bytes are kept by content hash, apart from
 * the file's record.
 */
export const BINARY_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/bmp",
  "audio/wav",
  "audio/mpeg",
  "audio/flac",
] as const;

/**
 * What a file holds, as a media type (files unification design, D3). It also
 * says how a text value is shown.
 */
export const MediaType = z.enum([...TEXT_MEDIA_TYPES, ...BINARY_MEDIA_TYPES]);
export type MediaType = z.infer<typeof MediaType>;
export type TextMediaType = (typeof TEXT_MEDIA_TYPES)[number];
export type BinaryMediaType = (typeof BINARY_MEDIA_TYPES)[number];

export const isBinaryMediaType = (t: string): t is BinaryMediaType =>
  (BINARY_MEDIA_TYPES as readonly string[]).includes(t);

/** `image` or `audio` for a binary media type; undefined for text. */
export const mediaKindOf = (t: string): MediaKind | undefined =>
  t.startsWith("image/") && isBinaryMediaType(t)
    ? "image"
    : t.startsWith("audio/") && isBinaryMediaType(t)
      ? "audio"
      : undefined;

/** Where a binary file's bytes are kept: their SHA-256 and length. */
export const BlobRef = z.object({
  hash: z.string(),
  size: z.number().int().nonnegative(),
});
export type BlobRef = z.infer<typeof BlobRef>;

/** A file, or a memory note (whose key is its generated id). */
export const EntryKind = z.enum(["file", "note"]);
export type EntryKind = z.infer<typeof EntryKind>;

/** One change to a session-scoped entry, recorded in the transcript. */
export const EntryOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("put"),
    kind: EntryKind,
    key: z.string(),
    value: z.string(),
    /** Files only. */
    mediaType: MediaType.optional(),
    /** Binary files only: the bytes. `value` is empty then. */
    blob: BlobRef.optional(),
  }),
  z.object({ op: z.literal("delete"), kind: EntryKind, key: z.string() }),
  /** An explicit folder (files unification design, D6). */
  z.object({
    op: z.literal("folder"),
    action: z.enum(["create", "delete"]),
    path: z.string(),
  }),
]);
export type EntryOp = z.infer<typeof EntryOp>;

/**
 * One change to a session-scoped schema or piece of data, recorded in the
 * transcript (schemas and data design, decision 4). A schema's "put" carries
 * its whole current state, including every version's JSON Schema so far;
 * a data "put" carries its whole current state.
 */
export const DataOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("schema_put"),
    id: z.string(),
    name: z.string(),
    description: z.string(),
    /** The latest version. */
    version: z.number(),
    /** The JSON Schema of this put's version (`version`). */
    body: z.unknown(),
    /** The schema this one was copied from (decision 12). */
    copiedFrom: z.string().optional(),
  }),
  z.object({ op: z.literal("schema_delete"), id: z.string() }),
  z.object({
    op: z.literal("data_put"),
    id: z.string(),
    schemaId: z.string(),
    /** The pinned schema version (decision 6). */
    schemaVersion: z.number(),
    name: z.string(),
    description: z.string(),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("data_delete"), id: z.string() }),
]);
export type DataOp = z.infer<typeof DataOp>;

/** A file a tool result refers to; the model is shown it (see `media.ts`). */
export const MediaRef = z.object({
  /** A reference such as `session://cat.png`. */
  ref: z.string(),
  /** The agent asked to keep it in later requests (D40). */
  keep: z.boolean().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const ToolResultMessage = z.object({
  role: z.literal("tool"),
  callId: z.string(),
  /** The tool that was called. */
  name: z.string(),
  /** The text the model receives. */
  content: z.string(),
  isError: z.boolean(),
  /** The tool's structured result. Not sent to the model as is. */
  data: z.unknown().optional(),
  /**
   * Images and audio the result refers to. The model gets them in a user
   * message after the turn's tool results (files unification design, D15).
   */
  media: z.array(MediaRef).optional(),
  /**
   * State the tool saved with this result (tools design 6.8). Not sent to
   * the model. The tool's latest saved state is rebuilt from the transcript.
   */
  state: z.unknown().optional(),
  /**
   * Changes the tool made to session-scoped files and memory notes. Not
   * sent to the model. Session-scoped entries are rebuilt from these and
   * from edit messages (files and memory design, decision 11).
   */
  entries: z.array(EntryOp).optional(),
  /**
   * Changes the tool made to session-scoped schemas and data. Not sent to
   * the model. Session schemas and data are rebuilt from these (schemas and
   * data design, decision 4).
   */
  dataOps: z.array(DataOp).optional(),
  /**
   * The note the user typed when allowing the call once or denying it
   * (approval notes design). Not sent as part of this message: the notes of
   * one turn's results are sent as one user message after them.
   */
  note: z
    .object({ text: z.string(), choice: z.enum(["once", "deny"]) })
    .optional(),
  /**
   * The form the tool showed during the call and how it was answered (tool
   * prompts D9, D10: at most one per call). Not sent to the model.
   */
  prompt: PromptRecord.optional(),
});

/**
 * The user changed session-scoped files or notes in the app. The model
 * reads `content` (a notice) as part of a user message; adapters join it
 * to a neighbouring user message (files and memory plan, P3 and P4).
 */
export const EditMessage = z.object({
  role: z.literal("edit"),
  content: z.string(),
  entries: z.array(EntryOp),
  /** Changes to session schemas and data (schemas and data design). */
  dataOps: z.array(DataOp).optional(),
});

/** Provider-neutral message. Model adapters translate to and from it. */
export const Message = z.discriminatedUnion("role", [
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  EditMessage,
]);
export type Message = z.infer<typeof Message>;
export type UserMessage = z.infer<typeof UserMessage>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;
export type ToolResultMessage = z.infer<typeof ToolResultMessage>;
export type EditMessage = z.infer<typeof EditMessage>;

/** Messages as sent to a model: edit messages folded into user ones. */
export type ModelMessage = Exclude<Message, EditMessage>;

/** A tool the model may call. `inputSchema` is JSON Schema. */
export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;
