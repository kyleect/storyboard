import { z } from "zod";

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

export const UserMessage = z.object({
  role: z.literal("user"),
  content: z.string(),
});

export const AssistantMessage = z.object({
  role: z.literal("assistant"),
  content: z.array(ContentBlock),
});

/** How a file's value is shown (files and memory design, decision 5). */
export const FileType = z.enum(["plain", "markdown", "json"]);
export type FileType = z.infer<typeof FileType>;

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
    type: FileType.optional(),
  }),
  z.object({ op: z.literal("delete"), kind: EntryKind, key: z.string() }),
]);
export type EntryOp = z.infer<typeof EntryOp>;

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
