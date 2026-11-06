# Backend (`@harness/backend`)

The backend is a Node process built on [Fastify](https://fastify.dev). It owns
all state. It stores sessions, projects, messages and events in an encrypted
SQLite database; starts and supervises runs by driving core's agent loop;
serves the HTTP API; and pushes events to the UI over server-sent events (SSE).

```
packages/backend
  migrations/            0001_init.sql … 0022_tool_grants.sql
  src/
    main.ts              startup, wiring, shutdown
    config.ts            data directory and file locations
    db.ts                encrypted database, key file
    migrate.ts           migration runner
    token.ts             API token file
    settings.ts          settings: defaults, environment, stored values
    server.ts            Fastify app: auth, core routes, event streams
    agent-routes.ts      agent HTTP routes         ┐
    skill-routes.ts      skill HTTP routes         │ registered by server.ts
    entry-routes.ts      file and note routes      │
    data-routes.ts       schema and data routes    ┘
    runs.ts              RunManager (the heart of the backend)
    store.ts             sessions, projects, messages, runs, events (SQL)
    agents-store.ts      agents and versions
    skills-store.ts      skills and versions
    entries-store.ts     project/global files and notes, versions
    data-store.ts        global/project/agent schemas and data, versions
    tool-settings.ts     per-tool approval, always-on and off settings
    tool-grants.ts       an agent's tool grant: groups, exceptions, extras
    tool-access.ts       project and agent access for tools
    placeholders.ts      {{skills}} {{tools}} {{schemas}} {{data}} {{agents}}
    default-agent.ts     which agent a new session starts with
    search-index.ts, search.ts, embedder.ts, embed-prefix.ts   search
    json-schema.ts       Ajv-based schema checker
    errors-store.ts      recorded tool errors and failed runs
    app-events.ts        app-wide event bus
    auto-title.ts        session titles
    trash.ts             purge of expired trash
    session-debug.ts     debugging export
```

## Startup and shutdown

`main.ts` wires everything together in this order:

1. Restrict file permissions (`umask 077`) so every file the backend creates is
   owner-only.
2. Read bootstrap paths from the environment (`config.ts`).
3. Load or create the database key; open the encrypted database.
4. Apply pending migrations.
5. Create the stores (`Store`, `EntryStore`, `AgentStore`, `SkillStore`,
   `DataStore`, `McpServerStore`) and the `SearchIndex`.
6. Create the `McpManager` (it connects in step 11).
7. Create the `RunManager`, giving it the stores, the settings reader, a factory
   for the llama-server adapter, the full tool list, the MCP manager's tools
   (`dynamicTools`), and the prompt builders from the tools package.
8. **Recover**: runs still marked `running` from a previous process are closed as
   `interrupted` (see [recovery](#recovery)).
9. **Purge expired trash** according to `trashRetentionDays`.
10. **Index** existing files and notes if the search index has not been built.
11. Load or create the API token; start the `Embedder`; build the Fastify server;
    **start the MCP servers**, which connect in the background (the backend does
    not wait for them); listen on `127.0.0.1` at the configured port.
12. Write `backend.json` (`pid`, `port`, `token`) and print the dev frontend URL
    containing the token in its fragment.

On `SIGINT` or `SIGTERM` the backend stops accepting new runs, aborts active runs
(they end as `interrupted` and keep their partial output), waits for them, closes
the MCP connections (which stops the programs it started), stops the embedder,
closes the server and the database, removes `backend.json` and exits.

The server binds only to the loopback address. Nothing else is exposed.

## Database and migrations

### Encryption and key

The database is encrypted with SQLCipher-compatible settings
(`better-sqlite3-multiple-ciphers`, `cipher=sqlcipher`, `legacy=4`), so the stock
`sqlcipher` tool can open it with the key. The key is 256 random bits stored as
64 hex characters in `harness.key`.

- If the key file exists it must be mode `600` and valid, or startup stops with
  an instruction.
- If neither the key file nor the database exists, a key is created.
- If the database exists but the key file does not, startup stops: the database
  cannot be opened without it.

After opening, the connection loads the `sqlite-vec` extension (for vector
search) and sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`.

### Migrations

`migrate.ts` is a small hand-written runner.

- Migrations are plain SQL files named `NNNN_name.sql` in
  `packages/backend/migrations`, applied in numeric order. Gaps are allowed.
- Each runs in its own transaction taken with `BEGIN IMMEDIATE`, and re-checks
  under the lock, so two processes cannot apply the same migration.
- The SHA-256 checksum of each applied file is stored in `schema_migrations`.
  If an applied file changes, or its file goes missing, startup stops with a
  diagnostic. `repairMigration(version)` stores the new checksum when a change is
  intentional and the database already matches.
- There are no down migrations.

### Tables

| Area             | Tables                                                                                     | Notes                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| MCP              | `mcp_servers`                                                                              | Servers the backend connects to; see [MCP servers](#mcp-servers).                             |
| Settings         | `settings`                                                                                 | `key`, JSON `value`. Includes the `toolApproval`, `toolAlwaysOn` and `toolsOff` values.       |
| Conversation     | `sessions`, `messages`, `projects`                                                         | `messages.message` holds the provider-neutral message as JSON; `seq` orders them per session. |
| Runs             | `runs`, `run_messages`, `events`, `session_tool_approvals`                                 | See below.                                                                                    |
| Files and memory | `entries`, `entry_versions`, `chunks`, `chunks_fts`, `chunk_vectors`, `search_index_state` | Project and global entries only.                                                              |
| Agents           | `agents`, `agent_versions`                                                                 |                                                                                               |
| Skills           | `skills`, `skill_versions`                                                                 |                                                                                               |
| Schemas and data | `schemas`, `schema_versions`, `data`, `data_versions`                                      | Global, project and agent only.                                                               |
| Diagnostics      | `errors`                                                                                   |                                                                                               |
| System           | `schema_migrations`                                                                        |                                                                                               |

**Sessions** have `title`, `project_id`, `agent_id`, `model`,
`reasoning_effort`, `trashed_at` and `trashed_with_project`. A `NULL` model or
effort means "use the default setting". **Projects** have `name`,
`description`, `system_prompt`, `default_agent_id`, `last_used_at` and
`trashed_at`.

**Runs** record `session_id`, `kind`, `status`, times, `usage`, `error`, the
`model`, `reasoning_effort`, `agent_id` and `agent_version` used,
`parent_run_id` and `parent_call_id` (for subagent runs), and the exact
`system_prompt` and `tools` sent to the model (kept for debugging).

**`run_messages`** links runs to the messages they wrote, in order. One message
can belong to several runs, because _continue_ writes into a message an earlier
run created.

**Events** have an `AUTOINCREMENT` id that is never reused (it is the replay id),
a nullable `run_id` (session events have none), `session_id`, `time`, `type`, and
JSON `data`.

**Versioned records.** `entries`, `agents`, `skills`, `schemas` and `data` each
have a table of current state and a `*_versions` table of every state they have
had, oldest first. A delete adds a version flagged `deleted`; nothing is removed.

**Built-ins.** Migrations insert the built-in records (the Dispatcher agent, three
schemas, four skills) flagged `builtin = 1`. They live in a scope of their own so
a user's record can share a name.

## Settings

`settings.ts` defines every setting with a Zod schema and a default. A value is
resolved by precedence: **environment variable, then stored value, then
default.** `GET /api/settings` returns the effective values, the stored values,
and which are overridden by the environment.

| Setting              | Env variable                   | Default                 | Meaning                                                            |
| -------------------- | ------------------------------ | ----------------------- | ------------------------------------------------------------------ |
| `llamaServerUrl`     | `HARNESS_LLAMA_URL`            | `http://127.0.0.1:8080` | Address of llama-server.                                           |
| `model`              | `HARNESS_MODEL`                | empty (not sent)        | Default model (router mode).                                       |
| `reasoningEffort`    | `HARNESS_REASONING_EFFORT`     | empty (not sent)        | Default effort; `none` turns reasoning off.                        |
| `port`               | `HARNESS_PORT`                 | `4317`                  | Backend port.                                                      |
| `loopLimit`          | `HARNESS_LOOP_LIMIT`           | `20`                    | Most model calls per run.                                          |
| `copyLimit`          | `HARNESS_COPY_LIMIT`           | `20` (max 200)          | Most keys per copy/move call.                                      |
| `trashRetentionDays` | `HARNESS_TRASH_RETENTION_DAYS` | `30`                    | Days in trash before purge at startup; `0` never.                  |
| `embeddingModel`     | `HARNESS_EMBEDDING_MODEL`      | empty                   | Router model for embeddings; empty means keyword search only.      |
| `autoRename`         | `HARNESS_AUTO_RENAME`          | `true`                  | Title a new session from its first message.                        |
| `autoRenameSource`   | `HARNESS_AUTO_RENAME_SOURCE`   | `model`                 | `model` or `message`.                                              |
| `titleModel`         | `HARNESS_TITLE_MODEL`          | empty                   | Model that writes titles; empty uses the session's model.          |
| `titlePrompt`        | `HARNESS_TITLE_PROMPT`         | built-in text           | System prompt of the title call.                                   |
| `systemPrompt`       | `HARNESS_SYSTEM_PROMPT`        | built-in text           | Global system prompt (see below).                                  |
| `defaultAgentId`     | `HARNESS_DEFAULT_AGENT_ID`     | empty                   | Global default agent.                                              |
| `childReminders`     | `HARNESS_CHILD_REMINDERS`      | `2`                     | Reminders a subagent gets before its last text is taken as output. |
| `childPrompt`        | `HARNESS_CHILD_PROMPT`         | built-in text           | Line appended to a subagent's system message.                      |
| `subagentDepth`      | `HARNESS_SUBAGENT_DEPTH`       | `2`                     | How deep subagents nest; `0` turns subagents off.                  |

Settings are read **each time a run starts**, so a change applies to the next run
and never to one in progress. Saving settings also notifies the embedder.

Three per-tool settings are stored separately, each under its own key, and only
differences from a tool's own default are stored:

- `toolApproval`: whether the tool asks before it runs.
- `toolAlwaysOn`: whether the tool is offered to every agent.
- `toolsOff`: the list of tools switched off for the whole harness.

## Authentication

Every route under `/api/`, including `/api/health`, requires the API token: in
an `Authorization: Bearer <token>` header, or, for EventSource (which cannot set
headers), in a `?token=` query parameter. The comparison is constant-time.
Request logs record only the path, never the query string, so the token is not
logged. The token is stored in `api.token` and is the same across restarts, so
open pages and printed links keep working. Deleting the file issues a new token.

## The Store

`store.ts` is plain SQL for the core records. The pieces that matter for
understanding the run system:

- **Messages** are written with `addMessage` and upserted by `saveMessage`. Each
  message records the model, effort, agent version and usage of the run that
  _last_ wrote it.
- **`listMessages(sessionId, only?)`** has three modes:
  - no filter: every message of the session, including subagents';
  - `"top"`: the messages a top-level run sees (excludes any message written by a
    child run);
  - `{ run }`: only the messages that run wrote (what a subagent sees).
- **Events** are inserted with `insertEvent` (returning the stored event with its
  id) and read with `eventsAfter(sessionId, id)` for replay and `runEvents(runId)`
  for recovery and snapshots.
- **Runs**: `createRun`, `endRun`, `runningRuns` (used by recovery),
  `subagentUsage`.
- **Session approvals**: `allowToolForSession` / `isToolAllowedForSession`.
- **Trash and purge**: `setSessionTrashed`, `trashProject`, `restoreProject`,
  `purgeSession`, `purgeProject`. A purge deletes the session's events, errors,
  runs, messages and approvals; entry and data versions it authored are kept with
  their session link cleared.

## The RunManager

`runs.ts` is where the backend meets core. It starts, supervises, answers and
records runs. It holds the set of **active runs** in memory and is the only
writer of run-related state.

### Responsibilities

- Start a run for a session (`sendMessage`, `continueLast`) and for a subagent.
- Persist every event, then fan it out to subscribers.
- Persist each message as the loop completes it.
- Hold open approval requests and forms until the user answers.
- Cancel runs; recover from crashes; shut down cleanly.
- Record user edits to session files and data as edit messages.
- Give a new session a title.
- Describe active runs for reconnecting clients (snapshots).

### One active top-level run per session

Every start goes through `requireIdle(sessionId)`: the backend must not be
shutting down, the session must exist and not be in the trash, and no run may be
active in it. Violations return 503, 404 or 409. (Subagent runs are children of
the active run and do not count separately.)

### Sending a message

`POST /api/sessions/:id/messages` → `sendMessage(sessionId, content, choices)`:

1. Check the session is idle and that any chosen agent is usable in the
   session (404 unknown, 409 deleted or from another project).
2. Save the choices (model, reasoning effort, agent) onto the session.
3. Decide whether the session should be auto-renamed (see
   [Titles](#session-titles)).
4. Append the user message to the transcript.
5. `launch(...)` the run, and return `{ runId }` immediately with status 202.
6. Start the title job in parallel if needed.

The HTTP request returns as soon as the run is started. All progress arrives on
the event stream.

`continueLast` works from the last message: after an assistant message with no
tool calls it continues that message; after a tool result it takes the next step;
otherwise it is refused.

### `launch`: building a run

`launch` assembles everything a run needs, then starts the loop.

1. **Resolve the generation.** Model and reasoning effort are the session's
   choice, else the setting, else empty (not sent). The agent is the session's
   picked agent if it is still usable, and the run keeps _that version_ until it
   ends. A subagent's run uses the agent it was started as.
2. **Resolve skills in scope** (built-in, global, project, agent) as they are
   now; the run keeps them until it ends.
3. **Choose the tools** ([below](#which-tools-a-run-gets)).
4. **List schemas and data in scope**, but only if the run offers a schema or data
   tool.
5. **Compose the system message** ([below](#the-system-message)).
6. **Record the run** (`createRun`) including the composed system message and the
   tool definitions.
7. **Build the request**: the system message, then the session's messages. A
   top-level run gets `listMessages(sessionId, "top")`; a subagent gets only the
   messages it wrote.
8. **Call `runLoop`** with a context that wires core to the backend: shared
   entries, shared data, the schema checker, search, projects, agents,
   subagents, approvals, forms, persistence and error reporting.
9. **When the loop returns**, set the run's final status and record a
   `run_failed` error if it failed without a tool having ended it.

### Which tools a run gets

`toolsFor(agent, run)` takes the run's facts (`hasSkills`, `isChild`,
`canStartSubagent`) and filters all tools:

1. Remove tools switched **off** for the whole harness (`toolsOff`).
2. Remove tools whose `available(run)` returns false (for example `skill_load`
   with no skill in scope, `subagent_handback` outside a child run, and
   `start_subagent` at the depth limit).
3. If the run has no agent, that is the final set.
4. With an agent, keep a tool if it is **always on** now or the agent's tool grant
   allows it.

### Tool grants

An agent does not hold a plain list of tool names. It holds one JSON **tool
grant** (`tool-grants.ts`), saved with every agent version:

| Field    | Meaning in `allow` mode                            | Meaning in `deny` mode                                                                     |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mode`   | The agent has only what it is given.               | The agent has everything but what is denied.                                               |
| `groups` | Every tool of a granted group.                     | Every tool of a denied group.                                                              |
| `except` | Tools switched off inside a granted group.         | Tools still allowed inside a denied group, and the needs-review tools the agent was given. |
| `extras` | Single tools granted outside any granted group.    | Single tools denied outside any denied group.                                              |
| `known`  | The tools that existed when the version was saved. | The same.                                                                                  |

`allowedNames(grant, tools)` works out the allowed tool names. A tool with
`needsReview` is never covered by a blanket grant: in `allow` mode it must be in
`extras`, in `deny` mode in `except`. Other helpers: `listedTools` shows a grant
as a mode plus a plain list (used by `agents_list` and by exports),
`newToolNames` finds tools that exist now but are not in `known` (the agent
routes return them as `newTools`), and `grantFromNames` builds a grant of single
tools only (used by imports, so a file can never grant more than it names).

On every agent save the routes remove always-on tools from `except` and
`extras`, and set `known` to the tools that exist now.

### The system message

The system message is composed fresh for each run and is **not** stored in the
transcript. It is recorded on the run row for debugging. Parts, in order, with
empty parts dropped and the rest joined by blank lines:

1. the global system prompt (`systemPrompt` setting);
2. the project's system prompt;
3. the agent's prompt;
4. the skills list and introduction, _unless_ a prompt above uses `{{skills}}`;
5. the schemas list and instruction, _unless_ a prompt above uses `{{schemas}}`;
6. the files and memory instruction (says whether the session is in a project);
7. for a subagent, its closing line (the agent's `childPrompt`, else the global
   one).

**Placeholders.** In prompts the user writes (parts 1 to 3), `{{skills}}`,
`{{tools}}`, `{{schemas}}`, `{{data}}` and `{{agents}}` are replaced once, when
the run starts, with what _this run_ has:

| Placeholder   | Expands to                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `{{skills}}`  | One line per skill in scope: `- name: description`.                                                     |
| `{{tools}}`   | One line per offered tool: name and the first sentence of its description.                              |
| `{{schemas}}` | One line per schema in scope. Empty if the run offers no schema or data tool.                           |
| `{{data}}`    | One line per piece of data in scope, with its schema's name.                                            |
| `{{agents}}`  | One line per startable agent: `- (id) name: description`. Empty unless the run offers `start_subagent`. |

Expansion is a single pass: text produced by an expansion is not scanned again.
Anything else in braces is left as typed. Because the same lists are generated
at launch, the model always sees what is actually available for the run.

### Approvals

For each call the loop asks the backend `needsApproval(tool)`. Whether a tool
_asks_ is decided by the first rule that applies:

1. The tool is always-asks (`approval: "always"`): it asks.
2. The running agent has its own setting for the tool: that setting decides.
3. A global per-tool setting is stored: that setting decides.
4. Otherwise the tool's default decides (`ask` asks, `never` does not).

A prompt is shown only if the tool asks **and** (it is always-asks **or** the user
has not already chosen _Allow for this session_ for it in this session).

When a prompt is needed the loop emits `tool.approval_requested`; the backend
stores the open request in the active run and waits. `POST
/api/runs/:id/approvals/:requestId` answers it. `answerApproval` enforces:

- An always-asks tool accepts only `once` and `deny`.
- If the **agent's own setting** is why it asks, `always` is refused (changing the
  global setting would not change what the agent says).
- A `note` is accepted only with `once` or `deny`.
- A `selection` of changes is accepted only with `once`, and only if the request
  has a review.
- For a request with a review, if the underlying data changed since it was shown
  the answer is rejected with 409 (the user must refresh or deny), and a
  selection that cannot be applied is rejected with 400 and the reasons.
- `session` records the tool in `session_tool_approvals`.
- `always` writes the global setting so that the tool no longer asks.

Two more endpoints support reviews: `…/check` validates a selection without
answering, and `…/refresh` recomputes the changes from current data.

### Forms

A tool's form becomes `input.requested`; the backend holds it in the run's open
inputs. `POST /api/runs/:id/inputs/:requestId` answers it. The backend validates
answers against the form with core's `checkAnswers` (400 on problems) and
resolves the loop's promise with the checked, trimmed answers, or with a skip.

### Subagents

A subagent is a child run.

1. The parent model calls `start_subagent`. The tool (core context) calls the
   run manager's `startChild`.
2. `startChild` verifies the agent exists, is usable in the session, and is
   marked startable, then `launch`es it with the parent's run id and call id.
3. The child's **first message** is the task, saved as a user message belonging
   to the child run. Its request contains only its own messages, so it does not
   see the parent's conversation.
4. The child's events are stored on the **same session stream** with its own
   `runId`, and `run.started` carries `parentRunId` and `parentCallId`. The UI
   uses these to nest the child's activity under the call that started it.
5. The child's approvals and forms go to the user, answered by the **child's**
   run id.
6. The child ends by calling `subagent_handback`, or by running out of
   reminders and giving its last text. The outcome returns to the parent as the
   tool result: `{ agent, output }` on success, or an error with the reason
   `failed`, `cancelled`, `iteration_limit` or `no_output`.
7. **Cancelling** any run in a tree cancels the root; the parent's abort signal
   propagates to every child. A child has no stop button of its own.

Limits: the depth is capped by `subagentDepth` (a top-level run is depth 0), and
a child run is subject to the same `loopLimit` as any run.

Although a child's request is isolated, **session-scoped files, notes, schemas
and data are rebuilt from all messages of the session, including subagents'**, so
what a subagent writes in the session scope is visible to the parent afterward.

### Persistence

The run manager publishes every event the same way: store it, then deliver it to
the subscribers of that session. Therefore anything a client sees has already
been saved.

- `onMessage` from the loop → `saveMessage` (upsert) and `linkRunMessage`.
  Tool results that changed session files or notes also update the search index.
- When a tool that writes schemas or data succeeds, the backend publishes an app
  event `data.changed`.
- The loop's `reportError` → the `errors` table and an `errors.changed` app event.
- When a run ends it records status, end time, usage and error.

Run status mapping: loop `failed` → `failed`; `cancelled` → `cancelled`; any
other reason → `finished`; but if the backend is shutting down, a run that
would have ended as `finished`/`cancelled` is recorded as `interrupted` and its
`run.finished` event becomes `run.interrupted`.

### Recovery

If the process dies mid-run, the next start calls `recover()`. For each run still
marked `running` it:

1. Rebuilds the half-written assistant message from the run's stored events and
   saves it (with the last usage that was streamed).
2. Emits `request.cancel` for every approval or form that was still open.
3. For each tool call in the run's messages with no result, adds an error result
   "Interrupted: the backend stopped before this call finished." The tool is
   **not** run again.
4. Emits `run.interrupted` and marks the run `interrupted`.

Open approvals and forms do not survive a restart; the transcript stays valid
(every call has a result), so the user can continue the session.

### Snapshots

`snapshot(sessionId)` describes the session's active runs for a client that is
(re)connecting: the last event id, and for each active run its model, effort,
agent, the in-flight message (rebuilt from stored events), the open approvals and
the open forms. Child runs are listed with their parent ids.

### Edits made by the user

When the user changes session-scoped files, notes, schemas or data in the UI,
`editSessionEntries` / `editSessionData` append an **edit message** carrying the
changes and a one-line notice, and publish `session.entries_changed` /
`session.data_changed`. These are refused while a run is active. The model sees
the notice on its next call, and replay picks the change up.

### Session titles

If `autoRename` is on, the session still has the default title ("New session"),
and it has no user message yet, then sending its first message also starts a
title job in the background:

- `autoRenameSource = "message"`: the title is the first line of the message,
  cleaned (quotes and trailing punctuation removed, at most 80 characters, cut at
  a word boundary).
- `autoRenameSource = "model"`: one model call with `titlePrompt` writes it. Any
  failure, abort or empty answer falls back to the message.

A title the user set in the meantime is never overwritten. The job ends with
`session.renamed`.

### Trash

`trashSession` and `trashProject` move items to the trash and emit
`session.trashed` for each session. Both are refused (409) while a run is active
in the session (or in any session of the project). Restoring a session whose
project is also trashed requires the caller to say whether the project returns
with all of its sessions or alone. Only items in the trash can be permanently
deleted. Items past the retention period are purged at startup.

## Agents, skills, entries, data

These four stores follow the same pattern, and all are used both by HTTP routes
(the UI) and by the tools (the model).

| Store        | Scope                            | Notes                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentStore` | global or project                | Name, description, prompt, tool grant, per-tool approval settings, `subagent` flag, per-agent `childReminders` and `childPrompt`. Names are unique per scope. Can be exported to and imported from Markdown with YAML front matter (`agent-files.ts`). |
| `SkillStore` | built-in, global, project, agent | Display name, a slug (`name`) derived from it, description, body. Slugs are unique per scope and at most 64 characters.                                                                                                                                |
| `EntryStore` | project or global                | Files (key, type, value) and notes. Session entries are in the transcript. `shared(projectId)` returns the `SharedEntries` view that core uses.                                                                                                        |
| `DataStore`  | global, project, agent           | Schemas with versions and data pinned to a schema version. `shared(owner)` returns `SharedData` for one run's project and agent.                                                                                                                       |

Common behaviour:

- **Versioning.** Each save, delete and restore adds a version. The current-state
  row always holds the latest state.
- **Soft delete.** Deleted rows remain, and can be restored.
- **Authorship.** Entry and data versions record who made the change (`user`, or
  `model` with session and run ids).
- **Scope by owner.** A run reaches only its own session's project and its own
  agent's scope. An agent's skills, schemas and data are in scope only while the
  agent is pickable, so they disappear and return with it.
- **Conflicts.** A schema save that makes data invalid does not break the data:
  data that passes the new version is moved to it, and data that fails stays on
  its old version and is flagged out of date until migrated.

`json-schema.ts` implements core's `SchemaChecker` with Ajv (JSON Schema
2020-12, strict mode, plus `ajv-formats`). It checks that a schema is valid,
that it uses only the supported features, and that every default matches its own
part of the schema.

### Default agent

A new session gets an agent chosen by `defaultAgentFor`: the project's default
agent if it has a usable one; otherwise the global `defaultAgentId`; otherwise
the built-in **Dispatcher**. The user's pick in the session wins afterwards. The
**Dispatcher**'s prompt tells it to greet the user, clarify the request with
`ask_user`, find a specialist with `agents_list`, start it with `start_subagent`,
and report back. It is restricted to those three tools (plus the always-on ones).

### Built-in records

| Kind    | Records                                   |
| ------- | ----------------------------------------- |
| Agent   | Dispatcher                                |
| Schemas | Task, Goal, Decision                      |
| Skills  | Schemas and data, Tasks, Goals, Decisions |

## MCP servers

The backend is an MCP client. Each row of `mcp_servers` is a server it connects
to; the server's tools become harness tools in the `mcp` group, so they go
through the same grants, approvals and settings as any other tool. Only tools are
used (not resources, prompts or sampling).

- **Transports.** `stdio`: the backend starts a program (`command`, `args`, `env`,
  `cwd`; `env` is added to a small safe subset of the backend's own, not all of
  it). `http`: a remote Streamable HTTP server (`url`, `headers`, for example an
  `Authorization` header). Secrets are stored in the encrypted database like the
  rest. A stdio server runs with the backend's permissions, so the settings page
  says to add only ones you trust.
- **Names.** A tool is named `mcp_<server>_<tool>`: the server's `name` (at most
  24 lowercase letters, digits and `-`), then the server's own tool name with
  characters a tool name cannot have turned into `_`, cut to 64 characters and
  made unique.
- **Approval and grants.** Every MCP tool asks by default; the server's hints
  never lower that. A tool the server does not mark `readOnlyHint` sets
  `needsReview`, so an agent's group grant does not cover it and it has to be
  granted on its own (see [tool grants](#tool-grants)).
- **Lifecycle.** `McpManager` connects enabled servers in the background at
  startup (15 s limit), lists their tools, and follows `tools/list_changed`. A
  tool of a server that is not connected is not offered to new runs. A call to a
  tool a run was already offered, when its server has gone, tries to reconnect
  once and otherwise fails with an error the model sees. Saving a server
  reconnects it with the new settings; turning it off closes the connection.
- **Results.** Text is passed on. Images, audio and binary resources are named
  and left out (the model is text only). A result the server marks as an error
  is an error result; one with no content but structured content is that as
  JSON. Results are cut at 60 000 characters, and a call times out after 60 s.
- **`RunManager.tools`** is the built-in tools followed by `dynamicTools()`, read
  each time, so a run starts with the tools that exist then.

Routes (all need the token):

| Route                                 | Does                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| `GET /api/mcp/servers`                | Every server with its status (`state`, `error`, `tools`).       |
| `POST /api/mcp/servers`               | Creates one (`name`, `enabled`, `config`); it connects at once. |
| `GET/PUT/DELETE /api/mcp/servers/:id` | Read, replace (reconnects), delete.                             |
| `POST /api/mcp/servers/:id/reconnect` | Connects again and answers when the attempt is over.            |

Not yet: OAuth for remote servers, the older SSE transport, and MCP resources and
prompts.

## Search

Files and notes in every scope are searchable by **keywords and by meaning**.

**Index.** Live entries are split into _chunks_ (`chunking.ts`: about 1,500
characters, split at headings, then blank lines, then sentences). Chunks go in
`chunks`, with an FTS5 index (`chunks_fts`, Porter stemming, kept in sync by
triggers). Session entries are indexed too, although they live in the
transcript; the run manager keeps the index in step with session changes.
Deleted entries have no chunks. Existing entries are indexed once at startup if
the index has not been built.

**Embeddings.** `chunk_vectors` holds one vector per chunk for the current
embedding model. A chunk with no vector is pending. The **Embedder** runs in the
background, embedding pending chunks in batches of 16 through llama-server's
`/v1/embeddings`. It never blocks writes. On failure it retries after 5 seconds,
doubling up to 5 minutes. When the embedding model setting changes, vectors from
other models are deleted and everything is embedded again. With no embedding
model set it does nothing. Models whose names contain `nomic-embed-text` get the
`search_document: ` / `search_query: ` task prefixes they expect.

**Querying.** `sessionSearch` restricts the search to the session's scopes
(session, its project, global). It runs the FTS5 keyword query and, if an
embedding model is set, a cosine-distance vector query (sqlite-vec). The two
rankings are merged with **reciprocal rank fusion** (constant 60), grouped by
entry, with the best chunk as the excerpt. If there is no embedding model or the
query cannot be embedded, it returns keyword results with a notice that says why.

## Errors

The errors store records **tool errors** (`tool_threw`, `tool_returned_error`,
`unknown_tool`, `invalid_arguments`, `malformed_call`) and **failed runs**
(`run_failed`), with the message, details, stack, arguments, and links to the
session, run and the tool result message. Errors of trashed sessions are left out
of lists and an error is deleted with its session. Every change publishes the app
event `errors.changed`.

## Debug export

`GET /api/sessions/:id/debug` returns the session as a single JSON document
(`format: 1`): the session and project, each run with the **exact system prompt
and tool definitions it sent** and its model and agent version, every message
including subagents', and every stored event. It works for a session in the trash.

## HTTP API

All routes under `/api` require the token. Request bodies are validated with Zod;
errors return `{ error }` with a status (400 invalid request, 401 unauthorized,
404 not found, 409 conflict, 502 llama-server unreachable).

### Health and settings

| Method and path                                                    | Purpose                                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `GET /api/health`                                                  | Liveness.                                                  |
| `GET /api/settings`, `PUT /api/settings`                           | Read and update settings.                                  |
| `GET /api/tools`, `PUT /api/tools/:name/approval`                  | Per-tool approval settings.                                |
| `PUT /api/tools/:name/always-on`, `PUT /api/tools/:name/off`       | Always-on and off settings.                                |
| `PUT /api/tool-groups/:group`                                      | Apply `ask`, `alwaysOn` or `off` to every tool of a group. |
| `GET /api/models`, `POST /api/models/load`                         | List and load llama-server models.                         |
| `GET /api/models/reasoning-levels`, `GET /api/models/context-size` | Model properties from llama-server.                        |

### Sessions and projects

| Method and path                                                         | Purpose                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/sessions?projectId=`                                          | List sessions (a project's, or standalone).                                                |
| `POST /api/sessions`                                                    | Create (optionally in a project; applies the default agent).                               |
| `GET /api/sessions/:id`                                                 | Session detail: session, project, all messages, subagent usage, and the live-run snapshot. |
| `PATCH /api/sessions/:id`                                               | Rename, or change model, effort or agent.                                                  |
| `POST /api/sessions/:id/trash`, `…/restore`, `DELETE /api/sessions/:id` | Trash, restore, permanently delete (trashed only).                                         |
| `GET /api/sessions/:id/debug`                                           | Debug export.                                                                              |
| `GET /api/trash`, `DELETE /api/trash`                                   | List the trash; empty it.                                                                  |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`                 | List, create, read, update projects.                                                       |
| `POST /api/projects/:id/trash`, `…/restore`, `DELETE /api/projects/:id` | Trash, restore, permanently delete.                                                        |

### Runs

| Method and path                                              | Purpose                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/messages`                            | Send a user message and start a run (202 with `{ runId }`). Body may carry `model`, `reasoningEffort`, `agentId`. |
| `POST /api/sessions/:id/continue`                            | Continue the last message or take the next step.                                                                  |
| `POST /api/runs/:id/cancel`                                  | Cancel a run (and its children).                                                                                  |
| `POST /api/runs/:id/end-reasoning`                           | Ask the model to stop thinking and answer.                                                                        |
| `POST /api/runs/:id/approvals/:requestId`                    | Answer an approval: `choice`, optional `note`, optional `selection`.                                              |
| `POST /api/runs/:id/approvals/:requestId/check`, `…/refresh` | Validate a selection; recompute a review.                                                                         |
| `POST /api/runs/:id/inputs/:requestId`                       | Answer or skip a form.                                                                                            |

### Streams

| Path                           | Purpose                            |
| ------------------------------ | ---------------------------------- |
| `GET /api/sessions/:id/events` | The session's events, with replay. |
| `GET /api/events`              | App-wide events (not stored).      |

### Content by scope

The same sub-paths exist under each scope prefix:

| Prefix                     | Scope                                    |
| -------------------------- | ---------------------------------------- |
| `/api/global`              | global                                   |
| `/api/projects/:projectId` | a project                                |
| `/api/sessions/:sessionId` | a session                                |
| `/api/agents/:agentId`     | an agent (schemas and data, skills only) |

| Sub-path                                                          | Available under                 | Purpose                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/files`, `/files/:key`, `/notes`, `/notes/:id` (plus `/restore`) | global, project, session        | List, read, write, update, delete, restore files and notes.                                                        |
| `/data`, `/data/:dataId` (plus `/migrate`, `/restore`)            | global, project, agent, session | Data.                                                                                                              |
| `/schemas`, `/schemas/:schemaId` (plus `/restore`, `/copy`)       | global, project, agent, session | Schemas.                                                                                                           |
| `/agents`                                                         | global, project                 | Agents. Also `GET/PUT/DELETE /api/agents/:id`, `…/restore`, `…/versions/:seq`, `…/export`, `POST …/agents/import`. |
| `/skills`                                                         | global, project, agent          | Skills. Also `GET/PUT/DELETE /api/skills/:id`, `…/restore`.                                                        |

Other agent routes: `GET /api/sessions/:id/agents` (agents the session can pick),
`GET /api/agent-tools` (every tool with its group, whether it is always on or off,
and whether it needs review) and `GET /api/agent-tool-approvals`. `GET
/api/tools` also lists, for each tool, the agents that allow it
(`usedByAgents`), so Settings can say who is affected before a tool is switched
off. Agent responses include `newTools`.

### Errors

`GET /api/errors`, `GET /api/errors/filters`, `DELETE /api/errors`.

## Event streams

### Session stream: `GET /api/sessions/:id/events`

1. The client gives the last event id it has, in the `Last-Event-ID` header (sent
   automatically by `EventSource` when it reconnects) or the `lastEventId` query
   parameter on the first connect.
2. The server writes **all stored events after that id**, then keeps the
   connection open and writes live events as they are published. The backlog is
   read and the live subscription is registered in the same synchronous step, so no
   event can fall in between.
3. Each message is `id: <eventId>` followed by `data: <event JSON>` (the event
   without its id field). A `: keepalive` comment is sent after 10 seconds of
   silence.

The stream carries the session's events from all of its runs (top-level and
child) and session events.

### App stream: `GET /api/events`

Sends `AppEvent`s, not stored and not replayed:

| Event              | Meaning                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `mcp.changed`      | An MCP server was created, saved or deleted, or its connection or tools changed.                             |
| `agents.changed`   | An agent was created, saved, deleted, restored or imported (includes sessions whose agent pick was cleared). |
| `skills.changed`   | A skill changed.                                                                                             |
| `data.changed`     | Global, project or agent schemas or data changed.                                                            |
| `projects.changed` | A project was created by a tool.                                                                             |
| `errors.changed`   | An error was recorded, or errors were cleared.                                                               |

Because they are not replayed, a client refetches what it shows whenever the
stream opens or reopens.
