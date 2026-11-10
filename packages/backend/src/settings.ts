import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";
import { COPY_LIMIT_MAX, DEFAULT_COPY_LIMIT } from "@harness/core";

/*
 * Stored settings (design doc, "Configuration details"). Precedence, highest
 * first: environment variables, stored settings, defaults. Only the settings
 * this slice uses exist so far.
 */

export const Settings = z.object({
  llamaServerUrl: z.url(),
  /** Model name sent in `model` (router mode). Empty: not sent. */
  model: z.string(),
  /**
   * Default `reasoning_effort` for sessions with none chosen. Empty: not
   * sent; "none": reasoning off; otherwise a level such as "low".
   */
  reasoningEffort: z.string(),
  port: z.number().int().min(0).max(65535),
  /** The most model calls one run makes (design doc 6.17). */
  loopLimit: z.number().int().min(1),
  /**
   * The most files or notes one copy or move call may name (agent tools
   * design, Q11). Asking for everything in a scope is not limited by it.
   */
  copyLimit: z.number().int().min(1).max(COPY_LIMIT_MAX),
  /**
   * Days an item stays in the trash before it is purged at startup. 0: never
   * purged automatically (sessions and projects design, Q3d, Q3f).
   */
  trashRetentionDays: z.number().int().min(0),
  /**
   * The router model used for embeddings (files and memory design,
   * decision 25). Empty: none, so search is keyword only (decision 26).
   */
  embeddingModel: z.string(),
  /**
   * Renames a session still titled "New session" when its first user
   * message is sent (auto-rename plan, decisions 4, 5).
   */
  autoRename: z.boolean(),
  /** Where the title comes from (decision 1). */
  autoRenameSource: z.enum(["model", "message"]),
  /** The router model that writes titles. Empty: the session's model. */
  titleModel: z.string(),
  /** The system prompt of the title call (decision 3). */
  titlePrompt: z.string().min(1),
  /**
   * The global system prompt: first in the system message of every chat
   * run, before the project's and the agent's (system prompts design,
   * decisions 1 to 3). Empty: none.
   */
  systemPrompt: z.string(),
  /**
   * The global agent a new session starts with when its project has no
   * default of its own (global default agent design, decision 5). Empty:
   * none.
   */
  defaultAgentId: z.string(),
  /**
   * How many reminders a subagent gets when it stops without handing back,
   * before its last text is taken as its output (agent delegation design,
   * decisions 12, 13). An agent can set its own.
   */
  childReminders: z.number().int().min(0),
  /**
   * The line added at the very end of a subagent's system message. Empty:
   * none (subagents might then not work correctly). An agent can set its
   * own.
   */
  childPrompt: z.string(),
  /**
   * The line put before a message the user sends to a running subagent,
   * so the subagent can tell it from its task. Empty: no label.
   */
  subagentMessageLabel: z.string(),
  /**
   * How deep subagents can nest; a top-level run is depth 0. 0: subagents
   * are off.
   */
  subagentDepth: z.number().int().min(0),
  /**
   * The most images and audio files from earlier turns that stay in a
   * request when they are kept (files unification design, D14, D40). The
   * media of the current turn is always sent. 0: only the current turn's.
   */
  inlineMediaCap: z.number().int().min(0),
  /**
   * Keep media from earlier turns in the request when neither the user nor
   * the agent chose (D14). Off: older media is a text reference only.
   */
  keepMediaInline: z.boolean(),
  /**
   * The most characters one workspace file read returns (files unification
   * design, D47, D55). The agent reads the rest with offset and limit.
   */
  workspaceReadCap: z.number().int().min(100),
  /**
   * The agent whose prompt writes the text of an image or audio file
   * (files unification design, D43). Empty: nothing is generated.
   */
  mediaDescriberAgent: z.string(),
  /**
   * The router model that runs it. Empty: nothing is generated, though the
   * user can still type the text.
   */
  mediaDescriberModel: z.string(),
  /**
   * What editing a message does by default (message editing plan, part B):
   * "branch" keeps the old message and what followed on a branch of its own
   * and continues from the edited copy; "in_place" overwrites the text and
   * keeps the messages after it. Each edit can choose the other.
   */
  editMode: z.enum(["branch", "in_place"]),
  /**
   * Whether the model answers right after an edit that made a branch. An
   * edit in place never runs the model.
   */
  answerAfterEdit: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULTS: Settings = {
  llamaServerUrl: "http://127.0.0.1:8080",
  model: "",
  reasoningEffort: "",
  port: 4317,
  loopLimit: 20,
  copyLimit: DEFAULT_COPY_LIMIT,
  trashRetentionDays: 30,
  embeddingModel: "",
  autoRename: true,
  autoRenameSource: "model",
  titleModel: "",
  titlePrompt:
    "Write a short title (at most 6 words) for a chat session that starts with the user's message below. Reply with the title only.",
  systemPrompt: `
You are an expert AI agent operating inside an agent harness. You help users with whatever they need help with. Use the skills below to accomplish that goal.

Today is {{date}}. The time is {{time}}.

<skills>
{{skills}}
</skills>

<tools>
{{tools}}
</tools>

<schemas>
Schemas are named shapes for structured state, such as tasks or decisions. Data is made from a schema. Check the lists below, and use the schema and data tools to read or change them, before creating something that may already exist.

{{schemas}}
</schemas>

<data>
Each line is the name of a schema, then the name and description of a piece of data made from it.

{{data}}
</data>

<agents>
These are the agents available to you. If none appear below, then there are no agents available.

{{agents}}
</agents>

<workspaces>
These workspaces are available to you. Search in workspaces to find information.

{{workspaces}}
</workspaces>

<files>
These files are available to you. Search in files to find information.

{{files}}
</files>

<rules>
- Be concise in your responses
</rules>
  `.trim(),
  defaultAgentId: "",
  childReminders: 2,
  childPrompt:
    "You are working on a task for another agent. When you are done, call subagent_handback with your result. If you need something from the user, ask with ask_user, not in plain text.",
  subagentMessageLabel:
    "Message from the user (not from the agent that gave you your task):",
  subagentDepth: 2,
  inlineMediaCap: 4,
  keepMediaInline: false,
  workspaceReadCap: 10_000,
  mediaDescriberAgent: "builtin-media-describer",
  mediaDescriberModel: "",
  editMode: "branch",
  answerAfterEdit: true,
};

const ENV: Record<keyof Settings, string> = {
  llamaServerUrl: "HARNESS_LLAMA_URL",
  model: "HARNESS_MODEL",
  reasoningEffort: "HARNESS_REASONING_EFFORT",
  port: "HARNESS_PORT",
  loopLimit: "HARNESS_LOOP_LIMIT",
  copyLimit: "HARNESS_COPY_LIMIT",
  trashRetentionDays: "HARNESS_TRASH_RETENTION_DAYS",
  embeddingModel: "HARNESS_EMBEDDING_MODEL",
  autoRename: "HARNESS_AUTO_RENAME",
  autoRenameSource: "HARNESS_AUTO_RENAME_SOURCE",
  titleModel: "HARNESS_TITLE_MODEL",
  titlePrompt: "HARNESS_TITLE_PROMPT",
  systemPrompt: "HARNESS_SYSTEM_PROMPT",
  defaultAgentId: "HARNESS_DEFAULT_AGENT_ID",
  childReminders: "HARNESS_CHILD_REMINDERS",
  childPrompt: "HARNESS_CHILD_PROMPT",
  subagentMessageLabel: "HARNESS_SUBAGENT_MESSAGE_LABEL",
  subagentDepth: "HARNESS_SUBAGENT_DEPTH",
  inlineMediaCap: "HARNESS_INLINE_MEDIA_CAP",
  keepMediaInline: "HARNESS_KEEP_MEDIA_INLINE",
  workspaceReadCap: "HARNESS_WORKSPACE_READ_CAP",
  mediaDescriberAgent: "HARNESS_MEDIA_DESCRIBER_AGENT",
  mediaDescriberModel: "HARNESS_MEDIA_DESCRIBER_MODEL",
  editMode: "HARNESS_EDIT_MODE",
  answerAfterEdit: "HARNESS_ANSWER_AFTER_EDIT",
};

const NUMERIC = new Set<keyof Settings>([
  "port",
  "loopLimit",
  "copyLimit",
  "trashRetentionDays",
  "childReminders",
  "subagentDepth",
  "inlineMediaCap",
  "workspaceReadCap",
]);

const BOOLEAN = new Set<keyof Settings>([
  "autoRename",
  "keepMediaInline",
  "answerAfterEdit",
]);

/** "true" and "false" only; anything else is left for the schema to refuse. */
function parseBoolean(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

export interface SettingsView {
  /** What is in effect. */
  effective: Settings;
  /** What is stored in the database. */
  stored: Partial<Settings>;
  /** Settings currently overridden by an environment variable. */
  overriddenByEnv: Partial<Record<keyof Settings, string>>;
}

export function readSettings(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): SettingsView {
  const stored: Partial<Settings> = {};
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const shape = Settings.shape;
  for (const { key, value } of rows) {
    if (!(key in shape)) continue;
    const parsed = shape[key as keyof Settings].safeParse(JSON.parse(value));
    if (parsed.success) Object.assign(stored, { [key]: parsed.data });
  }

  const effective: Settings = { ...DEFAULTS, ...stored };
  const overriddenByEnv: SettingsView["overriddenByEnv"] = {};
  for (const key of Object.keys(ENV) as (keyof Settings)[]) {
    const raw = env[ENV[key]];
    if (raw === undefined) continue;
    const value = NUMERIC.has(key)
      ? Number(raw)
      : BOOLEAN.has(key)
        ? parseBoolean(raw)
        : raw;
    const parsed = shape[key].safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `Invalid ${ENV[key]}=${raw}: ${parsed.error.issues[0]?.message ?? ""}`,
      );
    }
    Object.assign(effective, { [key]: parsed.data });
    overriddenByEnv[key] = ENV[key];
  }
  return { effective, stored, overriddenByEnv };
}

/** Validates and stores a partial settings object. */
export function writeSettings(db: Database, patch: unknown) {
  const valid = Settings.partial().parse(patch);
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(valid)) {
      if (value !== undefined) upsert.run(key, JSON.stringify(value));
    }
  })();
}
