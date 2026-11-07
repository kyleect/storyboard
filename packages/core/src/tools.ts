import { z } from "zod";
import type { EntryAccess } from "./entries.js";
import type { Form, InputAnswer } from "./forms.js";
import type { Review, Selection } from "./review.js";
import type { DataAccess } from "./schemas-data.js";
import type { FileType, Message, ToolDefinition } from "./messages.js";

/*
 * Tools (tools design, section 6). A tool declares its input with Zod,
 * returns structured data that the harness serializes for the model, and may
 * save per-session state with its result.
 */

/**
 * A tool's approval default: ask before running ("ask"), run without asking
 * ("never"), or ask every time with no way to switch it off ("always": the
 * settings cannot change it, and the prompt offers only Allow once and
 * Deny).
 */
export type ApprovalDefault = "ask" | "never" | "always";

/*
 * Tool groups (tool management design, decisions 3, 4). Every tool belongs to
 * one group. The agent editor and Settings show tools under their group, and
 * an agent can be given or refused a whole group. The order is the order they
 * are shown in.
 */
export const TOOL_GROUPS = [
  { id: "files", label: "Files" },
  { id: "memory", label: "Memory" },
  { id: "structured-data", label: "Structured Data" },
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "subagents", label: "Subagents" },
  { id: "sessions", label: "Sessions" },
  { id: "skills", label: "Skills" },
  { id: "web", label: "Web" },
  { id: "mcp", label: "MCP" },
  { id: "utilities", label: "Utilities" },
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number]["id"];

/**
 * What a tool's `available` function can know about the run it would be
 * offered in (tool management design, decision 15).
 */
export interface RunFacts {
  /** Whether any skill is in scope for the run. */
  hasSkills: boolean;
  /** Whether the run is a subagent's. */
  isChild: boolean;
  /** Whether the run may still start a subagent (the depth limit is not reached). */
  canStartSubagent: boolean;
}

/** The most the "copy limit" setting can be set to (a call's key list is bounded by it). */
export const COPY_LIMIT_MAX = 200;

/** A project as `projects_list` shows it. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
}

/** The session's project, as `project_view` shows it. */
export interface ProjectInfo extends ProjectSummary {
  /** The name of the agent new sessions start with; null: none. */
  defaultAgent: string | null;
  /** Empty when there is none. */
  systemPrompt: string;
}

/**
 * A way to send files, notes, schemas, data and an agent to a project. It can
 * only write: nothing in the project can be read through it (agent tools
 * design, Q6, Q2 of the plan).
 */
export interface ProjectPush {
  /** Whether the project has a live file with this key. */
  hasFile(key: string): boolean;
  /** Creates or replaces a file. */
  putFile(key: string, type: FileType, value: string): void;
  /** Adds a note with a new id; returns the id. */
  addNote(text: string): string;
  /**
   * Creates a schema in the project's scope with every one of `versions`
   * (JSON Schemas, oldest first), so data pinned to an older version stays
   * valid. Returns the new schema's id. The name must be free in the project.
   */
  putSchema(schema: {
    name: string;
    description: string;
    copiedFrom: string | null;
    versions: readonly unknown[];
  }): string;
  /**
   * Creates data in the project's scope, pinned to a version of a schema the
   * project can use: a global or built-in one, or one made with `putSchema`.
   * Returns the new data's id.
   */
  putData(data: {
    schemaId: string;
    schemaVersion: number;
    name: string;
    description: string;
    value: unknown;
  }): string;
  /**
   * Copies the agent this run uses into the project as a project agent that
   * can be started as a subagent (whatever the original is), with what
   * belongs to it: its own skills, schemas (every version) and data. Data
   * made from a schema that is not global or built-in keeps working because
   * that schema is copied into the new agent's scope. Throws an `EntryError`
   * when the run has no agent, or its agent is a built-in one.
   */
  putAgent(): {
    id: string;
    name: string;
    skills: number;
    schemas: number;
    data: number;
  };
  /**
   * Makes the built-in Dispatcher the agent new sessions in the project start
   * with, when they would not start with it already (a global default agent
   * is set). Returns whether it changed anything.
   */
  useDispatcher(): boolean;
  /** Replaces the project's system prompt. */
  setSystemPrompt(text: string): void;
}

/** Projects, for the tools that list, view, create and send to them. */
export interface ProjectAccess {
  /** Projects not in the trash, by name. */
  list(): ProjectSummary[];
  /** The session's project; null for a standalone session. */
  current(): ProjectInfo | null;
  /** Creates a project. It has no default agent. */
  create(input: {
    name: string;
    description: string;
    systemPrompt: string;
  }): ProjectSummary;
  /**
   * A write-only handle for a project other than the session's own, or one
   * just created. Throws an `EntryError` when there is no such project or it
   * is in the trash.
   */
  push(projectId: string): ProjectPush;
}

/** An agent as `agents_list` and `agent_view` show it. */
export interface AgentSummary {
  id: string;
  name: string;
  scope: "global" | "project";
  /** The project's name for a project agent; null for a global one. */
  projectName: string | null;
  description: string;
  toolMode: "allow" | "deny";
  tools: string[];
  /** Whether it can be started as a subagent (agent delegation design 26). */
  subagent: boolean;
  /** True for an agent that comes with the app (decision 42). */
  builtin: boolean;
}

/** The agent a run uses. */
export interface CurrentAgent extends AgentSummary {
  version: number;
  /** The agent's system prompt, as of the version this run started with. */
  prompt: string;
}

/** The session's agents, for the tools that list and view them. */
export interface AgentAccess {
  /** The agents the session can pick: its project's, then global ones. */
  list(): AgentSummary[];
  /**
   * The agents this run can hand work to: those of `list()` that are marked
   * as startable (decision 26), without the run's own agent, which cannot
   * start itself.
   */
  startable(): AgentSummary[];
  /** The agent this run started with; null: none. */
  current(): CurrentAgent | null;
}

/** How a subagent's run ended, as the tool that started it sees it. */
export type SubagentOutcome =
  | {
      ok: true;
      /** The agent's name. */
      agent: string;
      /** What it handed back (or its last text, decision 7). */
      output: string;
    }
  | {
      ok: false;
      agent: string;
      /** How it ended (decision 8). */
      reason: "failed" | "cancelled" | "iteration_limit" | "no_output";
      /** What went wrong, for the parent. */
      message: string;
      /** The last text the subagent wrote, when it wrote any. */
      text: string;
    };

/** Starting subagents (agent delegation design). */
export interface SubagentAccess {
  /** How deep this run is: 0 for a top-level run (decision 25). */
  depth: number;
  /** Whether this run may start a subagent (the depth limit, decision 25). */
  canStart: boolean;
  /**
   * Starts a run of the agent as a subagent and waits for it to end. Throws
   * a `ToolError` when it cannot be started: no such agent, not marked as
   * startable (decision 26), or the depth limit.
   */
  start(input: {
    agentId: string;
    task: string;
    /** The `start_subagent` call, so the child run can be tied to it. */
    callId: string;
  }): Promise<SubagentOutcome>;
}

/**
 * Where a skill is defined (skills design, decision 1), or "builtin" for the
 * skills that come with the app (schemas and data design, decision 51).
 */
export type SkillScope = "builtin" | "global" | "project" | "agent";

/**
 * A skill as a run sees it: its content when the run started (skills design,
 * decision 13). `name` is the slug the model uses.
 */
export interface RunSkill {
  name: string;
  displayName: string;
  description: string;
  body: string;
  scope: SkillScope;
}

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
  /** The project's name, for forms; null for a standalone session. */
  projectName: string | null;
  /**
   * Files and memory notes (files and memory design, decision 21). Changes
   * to session-scoped entries are recorded with this call's result, and
   * only when the tool succeeds.
   */
  entries: EntryAccess;
  /**
   * Schemas and data (schemas and data design). Changes to session schemas
   * and data are recorded with this call's result, and only when the tool
   * succeeds.
   */
  data: DataAccess;
  /** Projects: list, view, create, and send entries to. */
  projects: ProjectAccess;
  /** The session's agents: list, view. */
  agents: AgentAccess;
  /** Starting subagents (agent delegation design). */
  subagents: SubagentAccess;
  /**
   * The most keys or ids one copy or move call may name (a setting). Asking
   * for everything in a scope is not limited by it.
   */
  copyLimit: number;
  /**
   * The skills in scope for this run, as they were when it started (skills
   * design, decisions 1, 13). Empty when there are none.
   */
  skills: readonly RunSkill[];
  /**
   * Shows the user a form in the chat and waits for the answer, for as long
   * as it takes (input forms design, D2). Rejects when the run is cancelled,
   * the run cannot ask, or the tool already asked during this call (tool
   * prompts D10). A tool's form and its answer are kept with the call's
   * result (D9).
   */
  requestInput: (form: Form) => Promise<InputAnswer>;
  /**
   * For a tool with `review` that asked: the review the user answered and
   * the changes they approved. `selection` undefined: all of them.
   */
  approval?: { review: Review; selection: Selection | undefined };
}

/**
 * A tool's description of a call's changes, for the approval prompt (plan
 * P5). `check` gives the problems with a selection (an empty list: it can
 * be applied); `stale` says whether what the changes were worked out from
 * has changed since.
 */
export interface ReviewPlan {
  review: Review;
  check: (selection: Selection) => string[];
  stale: () => boolean;
}

export interface ToolOutput {
  /**
   * Ends the run, and this text is its output: a subagent handing back
   * (agent delegation design, decisions 5, 22). The calls after it in the
   * same response are not run.
   */
  handback?: string;
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
  /** The group the tool is shown under. */
  group: ToolGroup;
  /**
   * Whether the tool is offered to every agent whatever its selection, until
   * Settings says otherwise (design, decisions 12, 13).
   */
  alwaysOn: boolean;
  /**
   * A destructive or prompt-changing tool. A group grant does not cover it:
   * an agent has it only when it is listed on its own (design, decision 11).
   */
  needsReview: boolean;
  /**
   * Whether it makes sense to offer the tool in this run (design, decision
   * 15). A tool without one is always available.
   */
  available?: (run: RunFacts) => boolean;
  /** JSON Schema for the model, generated from `input`. */
  inputSchema: Record<string, unknown>;
  /** Checks the model's arguments against the input schema. */
  parse: (
    args: unknown,
  ) => { ok: true; input: unknown } | { ok: false; error: string };
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolOutput>;
  /**
   * Works out the call's changes before asking (plan P5). Returns a
   * `ToolOutput` instead when the call is refused as it stands; that is the
   * call's result, and nothing is asked.
   */
  review?: (input: unknown, ctx: ToolContext) => ReviewPlan | ToolOutput;
}

export interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  /** Must be an object schema. Every integer needs both bounds. */
  input: S;
  approval: ApprovalDefault;
  group: ToolGroup;
  /** Default: false. */
  alwaysOn?: boolean;
  /** Default: false. */
  needsReview?: boolean;
  available?: (run: RunFacts) => boolean;
  execute: (
    input: z.output<S>,
    ctx: ToolContext,
  ) => Promise<ToolOutput> | ToolOutput;
  review?: (input: z.output<S>, ctx: ToolContext) => ReviewPlan | ToolOutput;
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
    group: spec.group,
    alwaysOn: spec.alwaysOn ?? false,
    needsReview: spec.needsReview ?? false,
    ...(spec.available ? { available: spec.available } : {}),
    inputSchema: schema,
    parse: (args) => {
      const result = spec.input.safeParse(args);
      return result.success
        ? { ok: true, input: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
    },
    execute: async (input, ctx) => spec.execute(input as z.output<S>, ctx),
    ...(spec.review
      ? {
          review: (input: unknown, ctx: ToolContext) =>
            (spec.review as NonNullable<ToolSpec<S>["review"]>)(
              input as z.output<S>,
              ctx,
            ),
        }
      : {}),
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
