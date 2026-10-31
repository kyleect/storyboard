import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlamaServerAdapter } from "@harness/core";
import { bootstrapFromEnv } from "./config.js";
import { loadOrCreateKey, openDatabase } from "./db.js";
import { loadMigrations, migrate } from "./migrate.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { loadOrCreateToken } from "./token.js";

/** Migrations ship as files next to the backend for now (see README). */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

async function main() {
  // Files the backend creates (database, WAL, key, runtime file) are owner-only.
  process.umask(0o077);
  const boot = bootstrapFromEnv();
  const key = loadOrCreateKey(boot.keyFile, boot.dbPath);
  const db = openDatabase(boot.dbPath, key);

  const applied = migrate(db, loadMigrations(MIGRATIONS_DIR));
  const store = new Store(db);
  const settings = () => readSettings(db).effective;

  const runs = new RunManager({
    store,
    settings,
    model: (s) => new LlamaServerAdapter({ baseUrl: s.llamaServerUrl }),
  });
  const recovered = runs.recover();

  const token = loadOrCreateToken(boot.tokenFile);
  const app = buildServer({ store, runs, token, logger: true });
  const { port } = settings();
  await app.listen({ host: "127.0.0.1", port });
  const address = app.server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  writeFileSync(
    boot.runtimeFile,
    JSON.stringify({ pid: process.pid, port: actualPort, token }),
    { mode: 0o600 },
  );

  app.log.info(
    {
      dataDir: boot.dataDir,
      migrationsApplied: applied,
      runsRecovered: recovered.length,
    },
    "backend ready",
  );
  // For development: open the frontend with the token in the URL fragment
  // (the fragment is not sent to any server).
  console.log(`\nFrontend (dev): http://localhost:5173/#token=${token}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    app.log.info("stopping");
    await runs.shutdown();
    await app.close();
    db.close();
    rmSync(boot.runtimeFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
