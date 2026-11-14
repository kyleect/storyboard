# AGENTS.md: `@harness/backend`

A Node process built on Fastify. It owns all state: sessions, projects,
messages and events in an encrypted SQLite database; it starts and supervises
runs by driving core's agent loop; it serves the HTTP API and pushes events to
the UI over server-sent events. Read the root `AGENTS.md` first. Background:
`docs/dev/backend.md` (long; the section outline is the useful part). Database
changes: also read `migrations/AGENTS.md`.

## Hard rules

- **Loopback only, token required.** The server listens on `127.0.0.1`. Every
  route under `/api/` (including `/api/health`) needs the API token, in an
  `Authorization: Bearer` header or, for EventSource, a `?token=` query
  parameter. Never log a token, a key, or a query string. New routes go under
  `/api/` and are covered by the same check; do not add unauthenticated routes.
- **Store, then send.** Every event is saved before it is delivered to
  subscribers, so whatever a client sees can be replayed. Do not publish an
  event around `RunManager`'s path.
- **`RunManager` (`runs.ts`) is the only writer of run-related state.** Routes
  call it; they do not write runs, run messages or run events themselves.
- **One active top-level run per session** (`requireIdle`). Subagent runs are
  children of the active run.
- **A session's transcript is a tree.** What the model, the files and the UI see
  is the line from the first message to the session's tip. Editing,
  regenerating and branching move the tip or add a sibling; they do not rewrite
  messages (except an in-place edit of the text). A new event field that holds a
  message id or a run id must be added to the lists in `fork.ts`, or forking will
  copy it wrongly; a test in `fork.test.ts` checks every event type.
- **No hard deletes of versioned records.** Files, agents, skills, schemas
  and data are soft-deleted with a new version flagged `deleted`; sessions and
  projects go to the trash first and are purged at startup after
  `trashRetentionDays`.
- **Files the backend creates are owner-only** (`umask 077` at startup; key and
  token files are mode `600`). Do not weaken this.
- **The database key file is never regenerated over an existing database.**
  Startup stops if the database exists without its key. Keep it that way.

## Layout

```
migrations/            NNNN_name.sql, applied in order (see migrations/AGENTS.md)
src/
  main.ts              startup, wiring, shutdown
  config.ts            data directory and file locations
  db.ts, migrate.ts    encrypted database and key file; migration runner
  token.ts             API token file
  settings.ts          every setting: Zod schema, default, env variable
  profiles.ts          profiles table and the active profile; stores read it per query
  server.ts            Fastify app: auth, core routes, event streams
  *-routes.ts          agent, skill, file (files), data, mcp, workspace, profile routes
  runs.ts              RunManager: starts, supervises, answers and records runs
  store.ts             sessions, projects, messages, runs, events (plain SQL)
  transcript.ts        reads the active line of a transcript straight from the database
  branches.ts, fork.ts message branches (a transcript is a tree with a tip) and forking a session
  *-store.ts           agents, skills, files, data, errors, mcp, workspaces
  tool-settings.ts, tool-grants.ts, tool-access.ts   which tools a run gets
  placeholders.ts      prompts as Mustache templates: {{skills}} {{tools}} {{schemas}} {{data}} {{agents}} {{files}} {{*_instruction}} ...
  search-index.ts, search.ts, embedder.ts   keyword and vector search
  mcp-manager.ts       connects to configured MCP servers
  workspace-*.ts       workspace folders: file access, indexing, search
  blobs.ts, media-*.ts binary files and image/audio handling
  trash.ts             purge of expired trash
  session-debug.ts     the debugging export
  test-helpers.ts      tempDatabase(), tempDir() and friends for tests
  test-fixtures/       a small MCP server used by tests
```

## Conventions

- **Plain SQL** through `better-sqlite3-multiple-ciphers`, in store classes
  (`Store`, `FileStore`, `AgentStore`, `SkillStore`, `DataStore`,
  `McpServerStore`, and so on). There is no ORM. Keep SQL in the stores and
  keep routes thin.
- **Routes** are registered by `register*Routes(app, deps)` functions called
  from `server.ts`. Validate params, query and body with Zod. Each routes file
  starts with a comment listing its endpoints; keep that list accurate.
  Changes are announced on the app-wide stream (for example `agents.changed`).
- **Settings** resolve as environment variable, then stored value, then
  default, and are read each time a run starts. A new setting needs a file in
  `settings.ts`, its env variable (`HARNESS_*`), the Settings page in the
  frontend, and a row in `docs/dev/backend.md` and `docs/dev/DEVELOPMENT.md` if it has
  an environment variable.
- **Prompts and tools given to a run** are recorded on the `runs` row for
  debugging. If you change how the system message or the tool list is built,
  keep recording the exact text and definitions that were sent.
- **Errors** from tools and failed runs are recorded in the `errors` table via
  `errors-store.ts`; do not swallow them.
- **Imports** end in `.js`. `@harness/core` and `@harness/tools` come in as
  packages (aliased to their source in tests).

## Testing

- Tests run in the Vitest `node` project.
- Use `tempDatabase()` from `test-helpers.ts` for a fresh encrypted, migrated
  database, and call its `cleanup()` in `afterEach`. Use `tempDir()` for plain
  folders. Never touch the real data directory.
- Drive runs with core's `ScriptedModel` or the fake llama-server from
  `@harness/core/testing`. Do not call a real llama-server.
- `server.test.ts` shows how to exercise the HTTP API; `mcp.test.ts` uses
  `src/test-fixtures/mcp-server.mjs`.

## Running

`pnpm dev:backend` from the root builds `@harness/tools` and runs
`tsx watch src/main.ts`; it prints a link of the form
`http://localhost:5173/#token=...` for the frontend. Environment variables are
listed in `docs/dev/DEVELOPMENT.md`. The three bootstrap paths (`HARNESS_DATA_DIR`,
`HARNESS_DB_PATH`, `HARNESS_KEY_FILE`) can only come from the environment.
Use a throwaway `HARNESS_DATA_DIR` when you try things out so you do not touch
real data.
