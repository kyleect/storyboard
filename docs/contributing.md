# Contributing: start here

This page gets a new developer from a fresh clone to a first change. It does not
repeat the other documents; it tells you what to read, how to run things, where
code lives, and how to make the common kinds of change.

## 1. Set up

You need **Node 22.22 or later** and **pnpm 10** (`engines` and `packageManager`
in the root `package.json`).

```sh
git clone https://github.com/kyleect/storyboard
cd storyboard
pnpm install
pnpm test            # runs without a model: tests use a scripted model and a fake llama-server
pnpm typecheck
pnpm lint
pnpm format:check
```

To run the app you also need a **llama-server** started with `--jinja` (tool calls
need it); see [DEVELOPMENT.md](DEVELOPMENT.md) for models, multimodal setup and
every environment variable.

```sh
pnpm dev:backend     # terminal 1: builds tools, then runs the backend with tsx watch
pnpm dev:frontend    # terminal 2: Vite on http://localhost:5173
```

The backend prints `Frontend (dev): http://localhost:5173/#token=…`. Open that
exact address: every request needs the token.

**Use a throwaway data directory while developing.** The backend keeps an
encrypted database, a key file and the API token in `HARNESS_DATA_DIR`. Start
the backend with your own folder to keep experiments away from real data:

```sh
HARNESS_DATA_DIR=/tmp/harness-dev pnpm dev:backend
```

Deleting that folder resets everything. The database cannot be opened without
`harness.key`; if you delete the key but keep the database, startup refuses to
continue.

## 2. Read in this order

1. [README.md](README.md): the system in one picture and the package rules.
2. [glossary.md](glossary.md): what _session_, _run_, _scope_, _transcript_,
   _tool grant_ and the other terms mean. Almost every other page assumes them.
3. [how-it-works-together.md](how-it-works-together.md): end-to-end scenarios
   (sending a message, approvals, subagents, reconnecting, crash recovery). This is
   the fastest way to see how the packages cooperate.
4. The page for the package you will change: [core.md](core.md),
   [tools.md](tools.md), [backend.md](backend.md) or [frontend.md](frontend.md).
5. [worked-example.md](worked-example.md) when you want one real conversation
   traced through every layer.

Each package also has an `AGENTS.md` with its rules in short form. They are
written for coding agents but are a good checklist for people too.

## 3. The shape of the system

```
packages/core       engine: messages, events, agent loop, tool API, llama-server adapter
packages/tools      every tool an agent can call (depends on core)
packages/backend    Fastify server, SQLite, RunManager, migrations (depends on core, tools)
packages/frontend   React + Mantine UI (depends on core for types and pure helpers only)
```

Four ideas explain most of the code:

- **The transcript is the source of truth.** A session is a tree of messages (see
  [Branches](backend.md#branches)); the line from the first message to the tip is
  what the model and the files see. Session-scoped files, notes, schemas and data
  are not tables; they are rebuilt by replaying changes recorded on that line.
- **Everything is an event.** A run only talks by emitting events. The backend
  stores each event, then sends it, so a client that reconnects replays what it
  missed.
- **Core asks, the backend answers.** Core declares interfaces (shared files, data,
  projects, agents, workspaces, a schema checker, search); the backend implements
  them over SQL. Tools reach the world only through these interfaces on
  `ToolContext`.
- **The user and the model can do the same things**, through the same stores, and
  every change is versioned and attributed. Nothing versioned is hard-deleted.

### Following one message through the code

1. The UI calls `api.sendMessage` (`frontend/src/api.ts`), which does
   `POST /api/sessions/:id/messages`.
2. The route in `backend/src/server.ts` validates the body and calls
   `RunManager.sendMessage` (`backend/src/runs.ts`). That saves the session's
   choices and the user message, starts the run (`launch`), and answers 202 with
   the run id.
3. `launch` resolves the model, agent and skills, chooses the tools, composes the
   system message (`placeholders.ts`), records the run, and calls `runLoop`
   (`core/src/loop.ts`).
4. `runLoop` calls the model through `LlamaServerAdapter`
   (`core/src/llama-server/adapter.ts`), runs the tools the model calls (asking the
   user first where required), and emits events.
5. For every event, `RunManager.publish` stores it (`Store.insertEvent`) and then
   delivers it to the session's listeners, which is what the SSE route streams.
6. In the browser, `useSessionEvents` (`frontend/src/live.ts`) applies each event
   to the live state (`useLive`), and invalidates TanStack Query caches when
   something finishes.

## 4. Where things live

| I want to change…                                        | Look at                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| What events exist, or their fields                       | `core/src/events.ts`                                                                                 |
| What happens when the model calls a tool                 | `core/src/loop.ts` (`runCall`)                                                                       |
| How a tool is declared, or what a tool can reach         | `core/src/tools.ts`                                                                                  |
| A tool itself                                            | `tools/src/*.ts`, registered in `tools/src/index.ts`                                                 |
| How requests to llama-server are built                   | `core/src/llama-server/adapter.ts`                                                                   |
| How a run is set up (model, agent, tools, system prompt) | `backend/src/runs.ts` (`launch`), `placeholders.ts`                                                  |
| Which tools an agent gets                                | `backend/src/tool-grants.ts`, `tool-settings.ts`, `tool-access.ts`                                   |
| Editing, branching and forking messages                  | `backend/src/branches.ts`, `fork.ts`, `RunManager` in `runs.ts`; `frontend/src/routes/Branching.tsx` |
| What is in the database                                  | `backend/migrations/*.sql`, `backend/src/store.ts` and the other `*-store.ts` files                  |
| An HTTP endpoint                                         | `backend/src/server.ts` or the matching `*-routes.ts`                                                |
| A setting                                                | `backend/src/settings.ts`, `frontend/src/routes/Settings.tsx`                                        |
| A page in the UI                                         | `frontend/src/routes/`, route table in `frontend/src/main.tsx`                                       |
| How the UI follows a live run                            | `frontend/src/live.ts`                                                                               |
| How search works                                         | `backend/src/search*.ts`, `embedder.ts`, `core/src/chunking.ts`                                      |

## 5. Recipes

### Add or change a tool

1. Write it with `defineTool` in the module for its topic in `packages/tools/src`
   and add it to `allTools` in `index.ts` (through the module's exported list if
   it has one). Give it a `group`, an `approval` default, a Zod `input`, and a
   `description` written for the model. Every integer field needs both `.min()`
   and `.max()`: `defineTool` rejects it otherwise.
2. Report expected failures as results (`fail(...)`, `guarded(...)`, or
   `isError: true`), not exceptions, so the model can recover.
3. If the tool needs something stateful that no `ToolContext` interface offers, add
   the interface in `core/src/tools.ts` (with a `NO_*` default if tests build a
   context by hand) and implement it in the backend. Tools never touch SQL.
4. Add a test next to it, and update the tool table in [tools.md](tools.md).
5. Check `tools/src/index.test.ts`: it lists every tool by name and checks its
   group, so it fails until you update it.

See [Writing a new tool](tools.md#writing-a-new-tool) for `alwaysOn`,
`needsReview` and `available`.

### Add a setting

1. Add it to the Zod schema, the defaults and the environment-variable map in
   `backend/src/settings.ts`. Precedence is environment variable, then stored
   value, then default; a setting is read each time a run starts.
2. Add it to the `Settings` interface in `frontend/src/api.ts`. The frontend does
   not import backend types, so its API types are hand-written mirrors that you
   must keep in step.
3. Add a control to the right section of `frontend/src/routes/Settings.tsx`.
4. Document it in the table in [backend.md](backend.md#settings) and, if it has an
   environment variable, in [DEVELOPMENT.md](DEVELOPMENT.md).

### Add a database change

Add a new file to `packages/backend/migrations`, named with the number after the
highest one already there (`0031_branches.sql` at the time of writing). **Never edit a migration that is already
committed**: its checksum is stored in every database that applied it, and startup
stops if it changes. There are no down migrations. If the change must rewrite JSON
stored inside messages, which SQL cannot do, add a data step in
`backend/src/data-steps.ts` instead of (or after) a migration. See
`packages/backend/migrations/AGENTS.md` for the rules, including how to rebuild a
table when SQLite cannot alter it. Document new tables in
[backend.md](backend.md#tables).

### Add an HTTP endpoint

1. Add the route to `backend/src/server.ts`, or to the `register*Routes` function
   for its area (`agent-routes.ts`, `skill-routes.ts`, `entry-routes.ts`,
   `data-routes.ts`, `mcp-routes.ts`, `workspace-routes.ts`). Validate params, query
   and body with Zod. All `/api/` routes already require the token.
2. Keep SQL in a store class; keep the route thin. Anything that starts or changes
   a run goes through `RunManager`.
3. If other windows should see the change, publish an app event
   (`backend/src/app-events.ts`) and handle it in `useAppEvents`
   (`frontend/src/live.ts`).
4. Add the method to `api` in `frontend/src/api.ts` with its types, and a test in
   `server.test.ts` or the area's test file.
5. Update the endpoint tables in [backend.md](backend.md#http-api).

### Add or change an event

1. Define it in `core/src/events.ts` (run events in `EventBody`, session events in
   `SessionEventBody`).
2. Emit it from core, or from `RunManager` for session events.
3. Handle it in the `switch` in `useSessionEvents` (`frontend/src/live.ts`). If it
   changes what a message looks like, `core/src/message-state.ts` is shared by the
   backend and the frontend.
4. Update the event tables in [core.md](core.md#events).

### Add a page to the UI

1. Create `routes/Name.tsx` and `routes/Name.test.tsx`.
2. Add a route in `frontend/src/main.tsx` and, if it belongs in the navbar, a link
   in `routes/Layout.tsx`.
3. Fetch with TanStack Query using a key from a factory in `frontend/src/queries/`
   (add a factory for a new feature, export it from `queries/index.ts`, and extend
   `queries/keys.test.ts`). **Never write a query key inline.**
4. Server data lives in the query cache; what is happening right now (a streaming
   message, an open approval) lives in `useLive`. Do not put server data in
   `useState`.
5. Update [frontend.md](frontend.md).

### Change what the model is told

The system message is composed in `backend/src/runs.ts` from the global prompt, the
project prompt, the agent's prompt, the skill and schema instructions (settings)
and the instruction blocks the tools package exports (`entriesInstruction`, …).
Prompts are Mustache templates; placeholders such as `{{tools}}` and `{{date}}`
are expanded in `placeholders.ts`.
The exact system message and tool definitions of every run are stored on the run
and shown in the Debug tab, so you can check what the model really got.

## 6. Tests

```sh
pnpm test                                   # everything
pnpm vitest run path/to/file.test.ts        # one file
pnpm vitest run -t "part of a test name"    # by name
```

`vitest.config.ts` defines two projects: `node` (all `packages/*/src/**/*.test.ts`)
and `frontend` (`packages/frontend/src/**/*.test.tsx`, run in jsdom with
`test-setup.ts`). Tests sit next to the code.

| You are testing…         | Use                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The agent loop or a run  | `ScriptedModel` (`core/src/fake-model.ts`); see `core/src/loop.test.ts`                                      |
| The llama-server client  | The fake llama-server from `@harness/core/testing`                                                           |
| A backend store or route | `tempDatabase()` from `backend/src/test-helpers.ts` (a fresh encrypted, migrated database; call `cleanup()`) |
| A tool                   | A hand-built `ToolContext`; see `tools/src/clock.test.ts`                                                    |
| A React component        | Testing Library with `MantineProvider`; stub the API with `vi.spyOn(api, "…")`; see `routes/Skills.test.tsx` |

Tests never call a real llama-server and never touch your real data directory.

## 7. Debugging

- **Debug tab** in a chat: a linear view of the whole session (system prompt and
  tool list of each run, messages, approvals), an event table, and each run's exact
  request. It can be copied as text or JSON.
- **Errors page** (`/errors`): every recorded tool error and failed run, linked to
  the message.
- **Open the database** with any SQLCipher-compatible tool using the key in
  `harness.key` (SQLCipher settings `cipher=sqlcipher`, `legacy=4`).
- **Backend logs** are on the terminal running `pnpm dev:backend`. Request logs
  never include the query string, so the token is not logged.
- A run that was in progress when the backend stopped ends as _interrupted_ and its
  partial text is kept; that is expected, not a bug.

## 8. Before you open a pull request

- `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm format:check` all pass. Do
  not work around a warning without understanding it.
- New behavior has a test.
- The docs that describe what you changed are updated (the table in section 4 and
  the recipes above name them).
- You did not edit an existing migration, add a hard delete for versioned data,
  log a token or key, or make core import Node APIs.
- You kept the existing comments that cite design decisions (for example "tools
  design, section 6"). Those design documents are kept outside this repository.

## 9. Things that surprise newcomers

- **No shared types package.** The frontend imports `@harness/core` for types and
  a few pure functions, but its API response types in `api.ts` are written by hand
  and must match the backend. `tool-grant.ts` and `attachments.ts` repeat backend
  rules on purpose; change both sides together.
- **Imports.** `core`, `tools` and `backend` use `.js` on relative imports; the
  frontend does not.
- **Aliases.** In tests and in the Vite dev server, `@harness/core` points at its
  source, so you rarely need to build. `pnpm dev:backend` builds `tools` first
  because the backend uses the built package.
- **Everything is soft-deleted.** Files, notes, agents, skills, schemas and data
  keep every version; sessions and projects go to the trash first and are purged at
  startup after the retention period.
- **One active run per session**, and edits to session files or data are refused
  while a run is active.
- **Prompts are data.** Built-in agents, schemas and skills are inserted by
  migrations (`builtin = 1`), so changing one means a new migration.
