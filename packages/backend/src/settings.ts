import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";

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
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULTS: Settings = {
  llamaServerUrl: "http://127.0.0.1:8080",
  model: "",
  reasoningEffort: "",
  port: 4317,
  loopLimit: 20,
};

const ENV: Record<keyof Settings, string> = {
  llamaServerUrl: "HARNESS_LLAMA_URL",
  model: "HARNESS_MODEL",
  reasoningEffort: "HARNESS_REASONING_EFFORT",
  port: "HARNESS_PORT",
  loopLimit: "HARNESS_LOOP_LIMIT",
};

const NUMERIC = new Set<keyof Settings>(["port", "loopLimit"]);

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
    const value = NUMERIC.has(key) ? Number(raw) : raw;
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
