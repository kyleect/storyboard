import { runDataSteps } from "./data-steps.js";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embedTexts, LlamaServerAdapter } from "@harness/core";
import {
  allTools,
  dataText,
  entriesInstruction,
  schemaDataTools,
  schemasInstruction,
  schemasText,
  skillsInstruction,
  skillsList,
} from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { AppEvents } from "./app-events.js";
import { DataStore } from "./data-store.js";
import { schemaChecker } from "./json-schema.js";
import { bootstrapFromEnv } from "./config.js";
import { loadOrCreateKey, openDatabase } from "./db.js";
import { Embedder } from "./embedder.js";
import { EntryStore } from "./entries-store.js";
import { McpManager } from "./mcp-manager.js";
import { MediaDescriber } from "./media-describer.js";
import { modelMediaSupport } from "./media-support.js";
import { McpServerStore } from "./mcp-store.js";
import { loadMigrations, migrate } from "./migrate.js";
import { RunManager } from "./runs.js";
import { SkillStore } from "./skills-store.js";
import { SearchIndex } from "./search-index.js";
import { sessionSearch } from "./search.js";
import { buildServer } from "./server.js";
import { readSettings } from "./settings.js";
import { Store } from "./store.js";
import { purgeExpiredTrash } from "./trash.js";
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
  runDataSteps(db);
  const store = new Store(db);
  const index = new SearchIndex(db);
  const entries = new EntryStore(db, undefined, undefined, index);
  const agents = new AgentStore(db);
  const skills = new SkillStore(db);
  const data = new DataStore(db, schemaChecker);
  const settings = () => readSettings(db).effective;
  const embed = (model: string, texts: string[], signal?: AbortSignal) =>
    embedTexts(settings().llamaServerUrl, model, texts, {
      ...(signal ? { signal } : {}),
    });

  const mcpStore = new McpServerStore(db);
  const events = new AppEvents();
  const mcp = new McpManager({
    store: mcpStore,
    events,
    // Only called after `app` exists: connections start below.
    onProblem: (message, err) =>
      app.log.warn({ err: err instanceof Error ? err.message : err }, message),
  });

  const describer = new MediaDescriber({
    db,
    settings,
    agents,
    model: (s) => new LlamaServerAdapter({ baseUrl: s.llamaServerUrl }),
    index,
  });
  describer.recover();
  const runs = new RunManager({
    store,
    describer,
    events,
    settings,
    model: (s) => new LlamaServerAdapter({ baseUrl: s.llamaServerUrl }),
    tools: allTools,
    mediaSupport: modelMediaSupport(() => settings().llamaServerUrl),
    dynamicTools: () => mcp.tools,
    agents,
    skills,
    skillsPrompt: skillsInstruction,
    skillsList,
    entries,
    data,
    schemaChecker,
    dataTools: schemaDataTools.map((t) => t.name),
    schemasPrompt: schemasInstruction,
    schemasList: schemasText,
    dataList: dataText,
    systemPrompt: (session) => entriesInstruction(session.project_id !== null),
    index,
    search: (session) =>
      sessionSearch({
        index,
        sessionId: session.id,
        projectId: session.project_id,
        embeddingModel: () => settings().embeddingModel,
        embed,
      }),
  });
  const recovered = runs.recover();
  const purged = purgeExpiredTrash(store, settings().trashRetentionDays);
  // Indexes existing files and notes once, after the search migration.
  const indexed = index.buildIfNeeded();

  const token = loadOrCreateToken(boot.tokenFile);
  const embedder = new Embedder({
    index,
    model: () => settings().embeddingModel,
    embed,
    // Only called after work starts, below, once `app` exists.
    onError: (err, retryInMs) =>
      app.log.warn({ err: err.message, retryInMs }, "embedding failed"),
  });
  const app = buildServer({
    store,
    runs,
    entries,
    agents,
    describer,
    skills,
    data,
    token,
    mcp: { store: mcpStore, manager: mcp },
    logger: true,
    onSettingsSaved: () => embedder.settingsChanged(),
  });
  index.onChunksAdded = () => embedder.kick();
  embedder.kick();
  // Servers connect in the background; the backend does not wait for them.
  mcp.start();
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
      entriesIndexed: indexed,
      trashPurged: {
        projects: purged.projects.length,
        sessions: purged.sessions.length,
      },
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
    describer.stop();
    await mcp.shutdown();
    await embedder.stop();
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
