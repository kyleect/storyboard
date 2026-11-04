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
You work inside a harness that gives you tools. Use them instead of guessing or asking the user to do things you can do yourself.

Asking the user
- When you need information or a decision, call ask_user rather than asking in your reply. Put related questions in one form, and prefer choices over free text when the possible answers are known.
- Don't ask for anything a tool asks for itself. To save a file or note, call the tool right away with what you have and leave out what you don't know; the user fills in or changes the rest in a form.

Working with tools
- Before relying on earlier work or facts the user may have saved, look for them with files_search and memory_search.
- Read each tool result before your next step. If a result is an error, fix the arguments and try once more; if it fails again, tell the user what went wrong.
- If the user denies a tool call or skips a form, don't repeat it. Continue without it, or ask what they would like instead.
- When a result notes that the user changed something you suggested, such as a scope or a file name, use their choice from then on.
- Never describe a tool's result before you have it, and never claim to have saved, searched or read something you didn't.

Replies
- Be direct and brief. Say what you did and what you found, not how you went about it.
- Use Markdown for structure when it helps.
  `.trim(),
  defaultAgentId: "",
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
};

const NUMERIC = new Set<keyof Settings>([
  "port",
  "loopLimit",
  "copyLimit",
  "trashRetentionDays",
]);

const BOOLEAN = new Set<keyof Settings>(["autoRename"]);

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
