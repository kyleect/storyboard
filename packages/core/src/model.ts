import type { RunControl } from "./control.js";
import type { MediaPolicy } from "./media.js";
import type {
  MediaKind,
  Message,
  TokenInfo,
  ToolDefinition,
  Usage,
} from "./messages.js";

/** Sampling settings passed through to the model server. */
export interface Sampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  seed?: number;
  maxTokens?: number;
}

/** A chat request: the server applies the model's chat template. */
export interface ChatRequest {
  kind: "chat";
  model?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  sampling?: Sampling;
  /**
   * Passed to the server as `reasoning_effort`: "none" turns reasoning off;
   * any other value (for example "low") goes to the chat template.
   */
  reasoningEffort?: string;
  /** Lets the caller end reasoning while the response streams. */
  control?: RunControl;
  /**
   * Looks up a file a user message refers to (`files`): its kind, media type
   * and bytes as base64, or undefined when it is no longer available.
   * Without it, or when it returns undefined, the adapter tells the model the
   * file is missing.
   */
  resolveFile?: (ref: string) => ResolvedFile | undefined;
  /**
   * How media is shown in this request: which files stay inline and which
   * become a text reference (see `media.ts`). Without it, every file a user
   * message names is inline and a tool result's media is not sent.
   */
  media?: MediaPolicy;
}

/** A file read for a request: what the adapter sends to the model. */
export interface ResolvedFile {
  kind: MediaKind;
  /** For example `image/png` or `audio/wav`. */
  mediaType: string;
  /** The file's bytes as base64. */
  data: string;
}

/** A raw request: plain text continued with no chat template. */
export interface RawRequest {
  kind: "raw";
  model?: string;
  prompt: string;
  sampling?: Sampling;
  /** Ask for per-token data (ids, probabilities). */
  tokenInfo?: { topN: number };
}

export type ModelRequest = ChatRequest | RawRequest;

/** What a model adapter yields while streaming one response. */
export type ModelChunk =
  | { type: "text"; text: string; tokens?: TokenInfo[] }
  | { type: "reasoning"; text: string }
  /** A complete tool call; `arguments` is the raw string from the model. */
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: "stop" | "length" | "tool_calls" };

/** Translates between the harness's types and one model server's API. */
export interface ModelAdapter {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}
