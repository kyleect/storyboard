import { homedir } from "node:os";
import { join } from "node:path";

/*
 * Bootstrap configuration (design doc, "Configuration details"): the
 * database path and key file location come from environment variables, and
 * default to the app's folder in ~/Library/Application Support.
 */

/**
 * Placeholder for the app's bundle identifier, which has not been chosen.
 * The Tauri app's identifier must match this.
 */
export const APP_ID = "harness";

export interface Bootstrap {
  dataDir: string;
  dbPath: string;
  keyFile: string;
  /** Written at startup so front ends can find the backend. */
  runtimeFile: string;
  /** The API token, kept across restarts. */
  tokenFile: string;
}

export function bootstrapFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Bootstrap {
  const dataDir =
    env.HARNESS_DATA_DIR ??
    join(homedir(), "Library", "Application Support", APP_ID);
  return {
    dataDir,
    dbPath: env.HARNESS_DB_PATH ?? join(dataDir, "harness.db"),
    keyFile: env.HARNESS_KEY_FILE ?? join(dataDir, "harness.key"),
    runtimeFile: join(dataDir, "backend.json"),
    tokenFile: join(dataDir, "api.token"),
  };
}
