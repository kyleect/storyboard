import { z } from "zod";
import type { EntryAccess } from "./entries.js";
import type { Form, InputAnswer } from "./forms.js";
import type { Message, ToolDefinition } from "./messages.js";

/*
 * Tools (tools design, section 6). A tool declares its input with Zod,
 * returns structured data that the harness serializes for the model, and may
 * save per-session state with its result.
 */

/** A tool's approval default: ask before running, or run without asking. */
export type ApprovalDefault = "ask" | "never";

export interface ToolContext {
  /** Fires when the run is cancelled. */
  signal: AbortSignal;
  sessionId: string;
  runId: string;
  callId: string;
  /** Reports progress, sent as `tool.update`. */
  update: (partial: string) => void;
  /**
   * The latest state this tool saved in the session's transcript, or
   * undefined when it has saved none (tools design 6.8).
   */
  state: unknown;
  /** The session's project; null for a standalone session. */
  projectId: string | null;
  /**
   * Files and memory notes (files and memory design, decision 21). Changes
   * to session-scoped entries are recorded with this call's result, and
   * only when the tool succeeds.
   */
  entries: EntryAccess;
  /**
   * Shows the user a form in the chat and waits for the answer, for as long
   * as it takes (input forms design, D2). Rejects when the run is cancelled
   * or the run cannot ask.
   */
  requestInput: (form: Form) => Promise<InputAnswer>;
}

export interface ToolOutput {
  /** The structured result. The harness serializes it for the model. */
  data: unknown;
  /** Replaces this tool's state. Left out: the state is unchanged. */
  state?: unknown;
  /** Marks the result as an error; the run continues. */
  isError?: boolean;
  /**
   * Extra detail about an error result for the errors console (error
   * reporting plan, P1). Read only when `isError` is true; never sent to
   * the model.
   */
  details?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  approval: ApprovalDefault;
  /** JSON Schema for the model, generated from `input`. */
  inputSchema: Record<string, unknown>;
  /** Checks the model's arguments against the input schema. */
  parse: (
    args: unknown,
  ) => { ok: true; input: unknown } | { ok: false; error: string };
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolOutput>;
}

export interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  /** Must be an object schema. Every integer needs both bounds. */
  input: S;
  approval: ApprovalDefault;
  execute: (
    input: z.output<S>,
    ctx: ToolContext,
  ) => Promise<ToolOutput> | ToolOutput;
}

/** Options for `ToolError` and `ToolRunError`. */
export interface ToolErrorOptions {
  /** Extra detail for the errors console; never sent to the model. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Thrown by a tool that failed. The model gets the message, as for any
 * thrown error; the errors console also gets `details` (error reporting
 * plan, P1).
 */
export class ToolError extends Error {
  override name = "ToolError";
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, options: ToolErrorOptions = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.details = options.details;
  }
}

/**
 * Thrown by a tool when continuing the run is pointless. Ends the run as
 * failed instead of returning an error result to the model (6.6).
 */
export class ToolRunError extends ToolError {
  override name = "ToolRunError";
}

/** One error in a cause chain, for error details. */
export interface ErrorCause {
  name: string;
  message: string;
  /** A Node error code, such as "ENOTFOUND", when there is one. */
  code?: string;
}

/**
 * The causes of an error, outermost first, not including the error itself.
 * Stops at 10, and at a cycle.
 */
export function errorCauses(err: unknown): ErrorCause[] {
  const causes: ErrorCause[] = [];
  const seen = new Set<unknown>([err]);
  let cause = err instanceof Error ? err.cause : undefined;
  while (cause !== undefined && !seen.has(cause) && causes.length < 10) {
    seen.add(cause);
    causes.push(describeError(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return causes;
}

function describeError(err: unknown): ErrorCause {
  if (!(err instanceof Error)) return { name: "Error", message: String(err) };
  const code = (err as { code?: unknown }).code;
  // An AggregateError (e.g. every address of a host refused) often has no
  // message of its own; its errors say what happened.
  const message =
    err.message === "" && err instanceof AggregateError
      ? err.errors
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join("; ")
      : err.message;
  return {
    name: err.name,
    message,
    ...(typeof code === "string" ? { code } : {}),
  };
}

export class ToolDefinitionError extends Error {
  override name = "ToolDefinitionError";
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): Tool {
  if (!NAME.test(spec.name)) {
    throw new ToolDefinitionError(
      `Tool name "${spec.name}" must be 1 to 64 letters, digits, "_" or "-".`,
    );
  }
  const schema = z.toJSONSchema(spec.input) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type !== "object") {
    throw new ToolDefinitionError(
      `Tool "${spec.name}": the input schema must be an object.`,
    );
  }
  const unbounded = unboundedIntegers(schema);
  if (unbounded.length > 0) {
    throw new ToolDefinitionError(
      `Tool "${spec.name}": integer fields need both .min() and .max() (tools design 6.2): ${unbounded.join(", ")}`,
    );
  }
  return {
    name: spec.name,
    description: spec.description,
    approval: spec.approval,
    inputSchema: schema,
    parse: (args) => {
      const result = spec.input.safeParse(args);
      return result.success
        ? { ok: true, input: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
    },
    execute: async (input, ctx) => spec.execute(input as z.output<S>, ctx),
  };
}

/** Paths of integer fields without both bounds (or with Zod's ±2^53 ones). */
function unboundedIntegers(node: unknown, path = "input"): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((n, i) => unboundedIntegers(n, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const found: string[] = [];
  const types = Array.isArray(o.type) ? o.type : [o.type];
  if (types.includes("integer")) {
    const bounded = (v: unknown) =>
      typeof v === "number" && Math.abs(v) < Number.MAX_SAFE_INTEGER;
    const low = bounded(o.minimum) || bounded(o.exclusiveMinimum);
    const high = bounded(o.maximum) || bounded(o.exclusiveMaximum);
    if (!low || !high) found.push(path);
  }
  for (const [key, value] of Object.entries(o)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, sub] of Object.entries(value)) {
        found.push(...unboundedIntegers(sub, `${path}.${prop}`));
      }
    } else if (typeof value === "object") {
      found.push(...unboundedIntegers(value, `${path}.${key}`));
    }
  }
  return found;
}

/** The definitions sent to the model. */
export function toolDefinitions(tools: readonly Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** The text form of a structured result (6.7): strings as is, else JSON. */
export function serializeResult(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "";
  return JSON.stringify(data);
}

/** The latest state the named tool saved in these messages (6.8). */
export function latestToolState(
  messages: readonly Message[],
  toolName: string,
): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool" && m.name === toolName && m.state !== undefined) {
      return m.state;
    }
  }
  return undefined;
}

/** Cuts text to `max` characters, saying how much was left out. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
