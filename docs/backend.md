# Backend (`@harness/backend`)

The backend is a Node process built on [Fastify](https://fastify.dev). It owns
all state. It stores sessions, projects, messages and events in an encrypted
SQLite database; starts and supervises runs by driving core's agent loop;
serves the HTTP API; and pushes events to the UI over server-sent events (SSE).

```
packages/backend
  migrations/            0001_init.sql … 0031_branches.sql
  src/
    main.ts              startup, wiring, shutdown
    config.ts            data directory and file locations
    db.ts                encrypted database, key file
    migrate.ts           migration runner
    data-steps.ts        one-time data changes SQL cannot make (run after migrations)
    token.ts             API token file
    settings.ts          settings: defaults, environment, stored values
    server.ts            Fastify app: auth, core routes, event streams
    agent-routes.ts      agent HTTP routes         ┐
    skill-routes.ts      skill HTTP routes         │
    entry-routes.ts      file, note, folder, blob  │ registered by server.ts
                         and media-describer routes│
    data-routes.ts       schema and data routes    │
    mcp-routes.ts        MCP server routes         │
    workspace-routes.ts  workspace routes          ┘
    runs.ts              RunManager (the heart of the backend)
    store.ts             sessions, projects, messages, runs, events (SQL)
    transcript.ts        reads the active line of a session's transcript straight from the database
    branches.ts          which messages a branch may start or end at, and the branching view of a session
    fork.ts              copies a session's line into a new session
    agents-store.ts      agents and versions
    agent-files.ts       agents as Markdown files (import and export)
    skills-store.ts      skills and versions
    entries-store.ts     project/global files, folders and notes, versions
    data-store.ts        global/project/agent schemas and data, versions
    mcp-store.ts         MCP server rows
    mcp-manager.ts       connects to MCP servers; their tools become harness tools
    workspaces-store.ts  workspaces and their attachments
    workspace-fs.ts      disk access for workspaces (path safety, stale check)
    workspace-index.ts   indexes ticked workspace files for search
    workspace-ticks.ts   the set of paths the user chose to search
    blobs.ts             bytes of binary files, by SHA-256
    file-lookup.ts       reads a referenced file's kind and bytes for a request
    media-detect.ts      which uploads are accepted, and how they are checked
    media-support.ts     whether the model in use reads images and audio
    media-describer.ts   writes a description or transcript of an image or audio file
    tool-settings.ts     per-tool approval, always-on and off settings
    tool-grants.ts       an agent's tool grant: groups, exceptions, extras
    tool-access.ts       project and agent access for tools
    placeholders.ts      {{skills}} {{tools}} {{schemas}} {{data}} {{agents}} {{workspaces}} {{date}} {{time}}
    default-agent.ts     which agent a new session starts with
    search-index.ts, search.ts, embedder.ts, embed-prefix.ts   search
    json-schema.ts       Ajv-based schema checker
    errors-store.ts      recorded tool errors and failed runs
    app-events.ts        app-wide event bus
    auto-title.ts        session titles
    trash.ts             purge of expired trash
    session-debug.ts     debugging export
    test-helpers.ts      tempDatabase() and friends, used by tests
    test-fixtures/       a small MCP server used by the MCP tests
```

## Startup and shutdown

`main.ts` wires everything together in this order:

1. Restrict file permissions (`umask 077`) so every file the backend creates is
   owner-only.
2. Read bootstrap paths from the environment (`config.ts`).
3. Load or create the database key; open the encrypted database.
4. Apply pending migrations, then run the data steps (see
   [Migrations](#migrations)).
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

**Data steps.** Some changes to stored data cannot be written in SQL, for example
rewriting the JSON inside `messages.message`. `data-steps.ts` holds these as
named steps (`file-ops-media-types`, `attachments-to-files`, `branches-backfill`). `runDataSteps` runs
each step once, in its own transaction, right after the migrations; the
`data_steps` table records which have run, so a second start changes nothing.
A step's name must never change once released, because the name is the record
that it ran.

### Tables

| Area             | Tables                                                                                                         | Notes                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP              | `mcp_servers`                                                                                                  | Servers the backend connects to; see [MCP servers](#mcp-servers).                                                                             |
| Settings         | `settings`                                                                                                     | `key`, JSON `value`. Includes the `toolApproval`, `toolAlwaysOn` and `toolsOff` values.                                                       |
| Conversation     | `sessions`, `messages`, `projects`                                                                             | `messages.message` holds the provider-neutral message as JSON; `seq` is insertion order. The transcript is a tree, see [Branches](#branches). |
| Binary files     | `blobs`                                                                                                        | The bytes of images and audio, by content hash; see [Binary files](#binary-files-and-attachments).                                            |
| Workspaces       | `workspaces`, `workspace_attachments`, `workspace_index_files`                                                 | Folders and what attaches them; see [Workspaces](#workspaces).                                                                                |
| Runs             | `runs`, `run_messages`, `events`, `session_tool_approvals`, `tool_subject_grants`, `session_subject_approvals` | See below.                                                                                                                                    |
| Files and memory | `entries`, `entry_versions`, `folders`, `chunks`, `chunks_fts`, `chunk_vectors`, `search_index_state`          | Project and global entries, and indexed workspace files (scope `workspace`).                                                                  |
| Agents           | `agents`, `agent_versions`                                                                                     |                                                                                                                                               |
| Skills           | `skills`, `skill_versions`                                                                                     |                                                                                                                                               |
| Schemas and data | `schemas`, `schema_versions`, `data`, `data_versions`                                                          | Global, project and agent only.                                                                                                               |
| Diagnostics      | `errors`                                                                                                       |                                                                                                                                               |
| System           | `schema_migrations`, `data_steps`                                                                              |                                                                                                                                               |

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

| Setting                 | Env variable                     | Default                   | Meaning                                                                           |
| ----------------------- | -------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `llamaServerUrl`        | `HARNESS_LLAMA_URL`              | `http://127.0.0.1:8080`   | Address of llama-server.                                                          |
| `model`                 | `HARNESS_MODEL`                  | empty (not sent)          | Default model (router mode).                                                      |
| `reasoningEffort`       | `HARNESS_REASONING_EFFORT`       | empty (not sent)          | Default effort; `none` turns reasoning off.                                       |
| `port`                  | `HARNESS_PORT`                   | `4317`                    | Backend port.                                                                     |
| `loopLimit`             | `HARNESS_LOOP_LIMIT`             | `20`                      | Most model calls per run.                                                         |
| `copyLimit`             | `HARNESS_COPY_LIMIT`             | `20` (max 200)            | Most keys per copy/move call.                                                     |
| `trashRetentionDays`    | `HARNESS_TRASH_RETENTION_DAYS`   | `30`                      | Days in trash before purge at startup; `0` never.                                 |
| `embeddingModel`        | `HARNESS_EMBEDDING_MODEL`        | empty                     | Router model for embeddings; empty means keyword search only.                     |
| `autoRename`            | `HARNESS_AUTO_RENAME`            | `true`                    | Title a new session from its first message.                                       |
| `autoRenameSource`      | `HARNESS_AUTO_RENAME_SOURCE`     | `model`                   | `model` or `message`.                                                             |
| `titleModel`            | `HARNESS_TITLE_MODEL`            | empty                     | Model that writes titles; empty uses the session's model.                         |
| `titlePrompt`           | `HARNESS_TITLE_PROMPT`           | built-in text             | System prompt of the title call.                                                  |
| `systemPrompt`          | `HARNESS_SYSTEM_PROMPT`          | built-in text             | Global system prompt (see below).                                                 |
| `skillsInstruction`     | `HARNESS_SKILLS_INSTRUCTION`     | built-in text             | Wording before the skill list when it is auto-inserted; `{{skills_instruction}}`. |
| `schemasInstruction`    | `HARNESS_SCHEMAS_INSTRUCTION`    | built-in text             | The same for the schema list; `{{schemas_instruction}}`.                          |
| `toolsInstruction`      | `HARNESS_TOOLS_INSTRUCTION`      | built-in text             | Wording for `{{tools_instruction}}`; empty when the list is.                      |
| `dataInstruction`       | `HARNESS_DATA_INSTRUCTION`       | built-in text             | Wording for `{{data_instruction}}`; empty when the list is.                       |
| `agentsInstruction`     | `HARNESS_AGENTS_INSTRUCTION`     | built-in text             | Wording for `{{agents_instruction}}`; empty when the list is.                     |
| `workspacesInstruction` | `HARNESS_WORKSPACES_INSTRUCTION` | built-in text             | Wording for `{{workspaces_instruction}}`; empty when the list is.                 |
| `filesInstruction`      | `HARNESS_FILES_INSTRUCTION`      | built-in text             | Wording for `{{files_instruction}}`; empty when the list is.                      |
| `defaultAgentId`        | `HARNESS_DEFAULT_AGENT_ID`       | empty                     | Global default agent.                                                             |
| `childReminders`        | `HARNESS_CHILD_REMINDERS`        | `2`                       | Reminders a subagent gets before its last text is taken as output.                |
| `childPrompt`           | `HARNESS_CHILD_PROMPT`           | built-in text             | Line appended to a subagent's system message.                                     |
| `subagentMessageLabel`  | `HARNESS_SUBAGENT_MESSAGE_LABEL` | built-in text             | Line put before a message the user sends to a running subagent. Empty: none.      |
| `subagentDepth`         | `HARNESS_SUBAGENT_DEPTH`         | `2`                       | How deep subagents nest; `0` turns subagents off.                                 |
| `inlineMediaCap`        | `HARNESS_INLINE_MEDIA_CAP`       | `4`                       | The most kept images and audio files from earlier turns sent with a request.      |
| `keepMediaInline`       | `HARNESS_KEEP_MEDIA_INLINE`      | `false`                   | Keep earlier turns' media in view when neither the user nor the agent chose.      |
| `mediaDescriberAgent`   | `HARNESS_MEDIA_DESCRIBER_AGENT`  | `builtin-media-describer` | The agent whose prompt writes the text of an image or audio file. Empty: off.     |
| `mediaDescriberModel`   | `HARNESS_MEDIA_DESCRIBER_MODEL`  | empty                     | The router model that runs it. Empty: off, so a new install writes none.          |
| `workspaceReadCap`      | `HARNESS_WORKSPACE_READ_CAP`     | `10000`                   | The most characters one workspace read returns (100 or more).                     |
| `editMode`              | `HARNESS_EDIT_MODE`              | `branch`                  | What saving an edit of a message does by default: `branch` or `in_place`.         |
| `answerAfterEdit`       | `HARNESS_ANSWER_AFTER_EDIT`      | `true`                    | Whether the model replies right after an edit that made a branch.                 |

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
- **`listMessages(sessionId, only?)`** has four modes:
  - no filter: the active view, meaning the line from the first message to the
    session's tip plus the subagent messages anchored to messages on that line;
  - `"top"`: the top-level messages of that line (what a top-level run sees);
  - `{ run }`: only the messages that run wrote (what a subagent sees);
  - `"all"`: every message of the session, deleted branches included (debug export).
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

## Binary files and attachments

An image or audio file is a **binary file**: a file like any other, with a media
type (`image/png`, `audio/wav`, …), in the session, project or global scope.
Attaching a file to a message uploads it to the session scope and the message
names it by reference (`files: ["session://cat.png"]`). See
[Multimodal models](./DEVELOPMENT.md#multimodal-models).

The bytes are in the `blobs` table (migration `0026`), once each, by the SHA-256
of their content (`blobs.ts`). A project or global file's record and each of
its versions point at a blob (`blob_hash`, `size`); a session file's
`put` operation in the transcript names the hash, so a rewind keeps the right
bytes. A **sweep** (`sweepBlobs`) deletes blobs nothing points at: no record, no
version and no stored message. It runs after versions are pruned and after a
session or project is purged. Project and global binary files keep their last 3
versions.

| Route                              | Does                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `POST <base>/files?name=&replace=` | Uploads one file. The body is the file; `Content-Type` is its media type. |
| `GET /api/blobs/:hash`             | The bytes under a hash, with their media type. Cached for good.           |

`<base>` is `/api/sessions/:id`, `/api/projects/:id` or `/api/global`. An upload
answers 201 with `key`, `ref`, `mediaType`, `size`, `blob` and `replaced`. `name`
is the file's path in the scope; without it the app names the file
(`image-2026-11-07-1432.png`, `recording-…wav`). A name in use gets a suffix
(`cat (2).png`) unless `replace=true`. Accepted: PNG, JPEG, GIF and BMP images
and WAV, MP3 and FLAC audio, which are what llama-server can read (WebP, OGG and
M4A are not). The media type must be one of these and the file's first bytes
must agree with it (400 otherwise); a bad name or an empty file is 400, a file
over 20 MB is 413, a body that is not a file (JSON or text) is 415, a missing
session or project 404 and one in the trash 409. There is no limit on how many
files a message names. Text files are saved with `PUT` and a value; a binary
media type there is 400.

A session upload is an edit message in the transcript, so it is refused while a
run is in progress. When a request is made, `fileResolver` (`file-lookup.ts`)
reads each referenced file's bytes from `blobs`, so they are sent to llama-server
but never copied into the transcript, events or the run's saved request. A
reference that cannot be found tells the model the file is no longer available.

### Media in requests

At the start of a run `launch` builds the `MediaPolicy` that goes in
`ChatRequest.media` (see core's `media.ts`): `cap` and `keepDefault` from the
settings above, `support` from `RunManagerOptions.mediaSupport(model)` (built in
`media-support.ts` from the model list's `input_modalities`, cached for 30
seconds; undefined when the server does not say), the user's choices from table
`media_choices` (migration `0027`, one row per session and reference, removed
with the session), and `info(ref)` from `fileLookup`. Choices and files are read
for every request, so a change during a run applies to the next call. The tool
context gets `mediaSupport` and `blobs.put`.

| Method and path                       | Purpose                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/sessions/:id/media-choices` | The user's keep or drop choices: `[{ ref, keep }]`.                                                        |
| `PUT /api/sessions/:id/media-choices` | `{ ref, keep }`; `keep: null` clears it. 400 if the ref is not an image or audio file the session reaches. |

MCP tools: an image or audio block of a result is saved as a session file
`mcp_<server>_<tool>-<n>.<ext>` (when the bytes match a type llama-server reads
and are under 20 MB), the result text names it (`[image saved as <session://…>]`)
and the tool returns it as `media`. Anything else is still named and left out.

`start_subagent` takes `files` (references to images or audio); they are sent
with the child's task message.

### Derived text and the Media Describer

An image or audio file has a _derived text_: a description, or a transcript for
audio. It is kept with the bytes in `blobs` (`derived_text`, `derived_state`:
`none`, `pending`, `generated`, `edited`, `failed`; migration `0028`), so it
serves a file in any scope and survives version pruning. Identical bytes share
one text, so editing it changes every file with those bytes.

`MediaDescriber` (`media-describer.ts`) writes it with the built-in Media
Describer agent (`builtin-media-describer`, inserted by `0028`: read-only, no
tools, startable as a subagent). It is one plain request, not a run: the
agent's prompt is the system message and the file is the user message, sent to
`mediaDescriberModel`. Generations run one at a time. A generation that takes
longer than 120 seconds, throws, or returns nothing marks the file `failed` and
keeps any earlier text; nothing retries by itself. A file is described when it
is uploaded (and when a tool saves one, such as an MCP image) unless it already
has text, and only while a model and an agent are set. A generation that was
running when the backend stopped is marked `failed` at the next start.

The text is indexed like a text file: its first 4,000 characters become the
file's chunks, for session, project and global files, and are re-made when the
text changes (`reindexBlob`). The rest is kept but not searched. A model that
cannot take a file is given its text in the `[Attached: …]` line.

| Method and path                        | Purpose                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/blobs/:hash/derived-text`    | `{ text, state }`.                                                                                   |
| `PUT /api/blobs/:hash/derived-text`    | `{ text }`: the user's text (`edited`); empty clears it (`none`).                                    |
| `POST /api/blobs/:hash/describe`       | Retry: write it again. 202; 409 when descriptions are off or one is running.                         |
| `GET /api/media-describer`             | `{ enabled, files, empty }`: what a change of the settings would touch.                              |
| `POST /api/media-describer/regenerate` | `{ mode: "empty" \| "all" }`: queues the files with no text, or all except text the user wrote. 202. |

Changing either describer setting writes nothing by itself: the app asks first
(`GET /api/media-describer`, then the user's answer to `regenerate`).

Attachments stored before this (table `attachments`, migration `0024`) are moved
by the data step `attachments-to-files` (`data-steps.ts`): each becomes a
session file, an edit message that adds the files is put before the message
that used them, and the message lists references. The table is dropped.

## Workspaces

A workspace (`workspaces`, migration `0029`) is a name, an absolute folder, a
`writable` flag and a trash state. `WorkspaceStore` (`workspaces-store.ts`)
checks that the folder exists and the name is unique (a name in the trash is
still taken). Projects and sessions attach workspaces (`workspace_attachments`),
each attachment with its own `read_only` choice. A session uses its project's
workspaces and its own; a workspace is writable in a session only if it is
writable and no attachment that applies says read-only, so an attachment can
only make it stricter. Moving a workspace to the trash hides it and keeps its
attachments (restoring brings it back); nothing on disk is touched, and
purging a session or project drops its attachments.

`workspace-fs.ts` is the disk side, behind core's `WorkspaceAccess`:

- Every path goes through `resolveIn`: relative to the folder, no `..` out, and
  the deepest existing part is resolved with `realpath`, so a symlink that leads
  out is refused (`WorkspaceError("outside")`). The tool may retry one call with
  `allowOutside` after the user said yes in a form.
- Names of new files and folders follow the file name rules.
- A file is text unless it has a NUL byte or is not UTF-8; images and audio are
  recognised by extension and content (20 MiB cap) and shown to the model through
  the same media mechanism as other files (`workspaceMediaSource`, read from disk
  when a request is built).
- **Stale check:** `write` and `edit` refuse a file that exists unless it was read
  in this session and its modified time and size are unchanged. The read records
  are in memory, per session, so a backend restart asks for a new read.
- Listing is cut at 2,000 entries and does not enter symlinked folders; deleting
  a folder does not follow links.

`{{workspaces}}` expands to one line per workspace the run has (name, reference,
"can be changed" or "read-only").

| Route                                                                    | Purpose                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `GET/POST /api/workspaces`, `PUT/DELETE /api/workspaces/:id`             | List (`?deleted=true` for the trash), create, save, move to the trash.            |
| `POST /api/workspaces/:id/restore`                                       | Restore from the trash.                                                           |
| `GET /api/projects/:id/workspaces`, `GET /api/sessions/:id/workspaces`   | What is attached; a session also lists its project's, with `effectiveWritable`.   |
| `PUT/DELETE /api/{projects,sessions}/:id/workspaces/:workspaceId`        | Attach (`{ readOnly }`) or detach.                                                |
| `GET /api/workspace-grants`, `DELETE /api/workspace-grants`              | "Always allow" grants per tool and workspace; remove one.                         |
| `GET /api/fs/dirs?path=`                                                 | The folders inside a folder, for the folder picker.                               |
| `GET /api/sessions/:id/workspace-file?ref=`                              | The bytes of a workspace image or audio file, for the chat.                       |
| `GET /api/workspaces/:id/tree?path=`                                     | One folder of the tree, each entry with its tick state (`all`, `some`, `none`).   |
| `GET /api/workspaces/:id/index`                                          | The ticks and the index status (files, chunks, scanning, truncated, unavailable). |
| `PUT /api/workspaces/:id/ticks`, `POST /api/workspaces/:id/ticks/toggle` | Set the ticks (`{ ticks }`) or tick or untick one path (`{ path, on }`).          |
| `POST /api/workspaces/:id/rescan`                                        | Rescan now.                                                                       |

### Searching a workspace

The user ticks what is searched; the ticks are a JSON array of paths relative to
the folder on the workspace row (`index_ticks`). A ticked folder covers everything
below it, and `""` means the whole folder. Unticking one entry inside a ticked
folder ticks the folder's other entries instead (`workspace-ticks.ts`). Paths are
checked with `resolveIn`, so a tick cannot leave the folder.

`WorkspaceIndexer` (`workspace-index.ts`) keeps the index current. Text files in
the ticked parts are chunked and stored in `chunks` with scope `workspace`, owner
the workspace id, key the path, so keyword search (FTS) and meaning search (the
embedder queue) work as for other chunks. `workspace_index_files` records each
file's modified time and size, so a rescan reads only what changed.

- **When:** at backend start (live workspaces with ticks), when a top-level run
  starts (its attached workspaces, waiting at most 5 seconds), when ticks, folder
  or trash state change, and on a chokidar watcher over the ticked paths. The
  watcher only schedules a debounced (300 ms) rescan; a rename shows as a delete
  and an add. A workspace in the trash has no chunks and no watcher; restoring
  indexes it again.
- **What:** text files up to 2 MiB, at most 5,000 files per workspace (the status
  says `truncated`). Images, audio, binary files and links that leave the folder
  are not indexed, and links to folders are not entered.
- **A folder that is gone** (an unplugged drive) keeps its index and is marked
  `unavailable`.

Migration `0030` adds the ticks, the fingerprint table and the `workspace` scope
of `chunks`. SQLite cannot change a CHECK, so it rebuilds `chunks`: it keeps the
ids, and saves and restores `chunk_vectors` and rebuilds `chunks_fts`, so no
embedding is computed again.

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

`POST /api/sessions/:id/messages` → `sendMessage(sessionId, content, choices, files)`.
The body is `content` (which may be empty when there are files),
`files` (references to image or audio files the session can reach, see
[Binary files](#binary-files-and-attachments); 400 for one that is not) and the choices:

1. Check the session is idle and that any chosen agent is usable in the
   session (404 unknown, 409 deleted or from another project).
2. Save the choices (model, reasoning effort, agent) onto the session.
3. Decide whether the session should be auto-renamed (see
   [Titles](#session-titles)).
4. Append the user message to the transcript, with the references of its
   files. A message with no text does not get the session a title.
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
4. the `skillsInstruction` setting and the skills list, _unless_ a prompt above
   uses `{{skills}}` or `{{skills_instruction}}`;
5. the `schemasInstruction` setting and the schemas list, _unless_ a prompt above
   uses `{{schemas}}` or `{{schemas_instruction}}`;
6. the files and memory instruction (says whether the session is in a project);
7. for a subagent, its closing line (the agent's `childPrompt`, else the global
   one).

**Placeholders.** In prompts the user writes (parts 1 to 3), `{{skills}}`,
`{{tools}}`, `{{schemas}}`, `{{data}}`, `{{agents}}`, `{{workspaces}}`, `{{files}}`,
the `…_instruction` placeholder of each list, `{{date}}` and `{{time}}` are replaced once, when the run starts, with what _this run_ has:

| Placeholder                                                                                                                      | Expands to                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{skills}}`                                                                                                                     | One line per skill in scope: `- name: description`.                                                                                                                        |
| `{{skills_instruction}}`                                                                                                         | The `skillsInstruction` setting. Empty if no skill is in scope.                                                                                                            |
| `{{tools}}`                                                                                                                      | One line per offered tool: name and the first sentence of its description.                                                                                                 |
| `{{schemas}}`                                                                                                                    | One line per schema in scope. Empty if the run offers no schema or data tool.                                                                                              |
| `{{schemas_instruction}}`                                                                                                        | The `schemasInstruction` setting. Empty if no schema is in scope.                                                                                                          |
| `{{data}}`                                                                                                                       | One line per piece of data in scope, with its schema's name.                                                                                                               |
| `{{agents}}`                                                                                                                     | One line per startable agent: `- (id) name: description`. Empty unless the run offers `start_subagent`.                                                                    |
| `{{workspaces}}`                                                                                                                 | One line per attached workspace: its name and reference, and whether it can be changed.                                                                                    |
| `{{files}}`                                                                                                                      | One line per file in the global, project and session scopes: `- <scope://name> (media type)`, then `: description` for a binary file that has one (cut at 120 characters). |
| `{{tools_instruction}}`, `{{data_instruction}}`, `{{agents_instruction}}`, `{{workspaces_instruction}}`, `{{files_instruction}}` | The setting of the same name (`toolsInstruction` and so on). Empty when its list is.                                                                                       |
| `{{date}}`                                                                                                                       | The weekday and date when the run starts, in the computer's time zone: `Friday, November 6, 2026`.                                                                         |
| `{{time}}`                                                                                                                       | The time on a 24-hour clock when the run starts, with the zone's short name: `14:32 PST`.                                                                                  |

The instruction placeholders are the wording apart from the data: a prompt can
place the introduction and the list in different places, with its own text between
them, or use only one. For skills and schemas, a prompt that writes either
placeholder of a pair takes over that pair, so the auto-insert (parts 4 and 5) is
skipped, and nothing is added for the one it left out. The other lists have no
auto-insert: they appear only where a prompt places them. The default global prompt
places every list with its instruction, so changing a setting changes the default.

Expansion is a single pass: text produced by an expansion is not scanned again.
Because the same lists are generated at launch, the model always sees what is
actually available for the run.

**Templates.** The three prompts are [Mustache](https://github.com/janl/mustache.js)
templates (`placeholders.ts`), so the same names also work as conditions.
`{{#skills}}Skills:\n{{skills}}{{/skills}}` is kept only when the run has
skills, `{{^skills}}No skills.{{/skills}}` only when it has none, and
`{{! note }}` is a comment. The values are plain text and are never
HTML-escaped. Two things differ from stock Mustache, so that nothing is dropped
without a word:

- A variable tag that is not a placeholder (`{{skils}}`, `{{Skills}}`) is left
  as typed. Mustache would render it as nothing.
- What cannot be left as typed is an error: a section on a name that is not a
  placeholder, a partial (`{{> x}}`), a change of delimiters, and a template that
  does not parse, such as an unclosed `{{`. The run then fails before the model
  is called. The error names the prompt, the line and the column, and is
  recorded like any failed run.

A prompt "uses" a placeholder, for the _unless_ in parts 4 and 5, when it writes
it as a variable tag (`{{skills}}`, `{{{skills}}}`, `{{&skills}}`), also inside a
section. A section on the name, or a comment, does not count.

The date and time are read once per run, so they do not move while a run goes
on. Each user message starts a new run, and a subagent is a run of its own: its
system message is built, and its placeholders expanded, when it starts, so it
gets the time then, not its parent's.

### Approvals

For each call the loop asks the backend `needsApproval(tool)`. Whether a tool
_asks_ is decided by the first rule that applies:

1. The tool is always-asks (`approval: "always"`): it asks.
2. The running agent has its own setting for the tool: that setting decides.
3. A global per-tool setting is stored: that setting decides.
4. Otherwise the tool's default decides (`ask` asks, `never` does not).

A prompt is shown only if the tool asks **and** (it is always-asks **or** the user
has not already chosen _Allow for this session_ for it in this session).

A tool can name a **subject** for a call (`approvalSubject`; today the workspace a
path is in). For such a call the order is: always-asks, the agent's setting, a
**grant** for that tool and subject (_Always allow_ in that workspace, table
`tool_subject_grants`), the global setting, the tool's default. A grant does not
override an agent that asks, and "Allow for this session" is kept per tool and
subject (`session_subject_approvals`). A call without a subject follows the rules
above unchanged.

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
- `session` records the tool in `session_tool_approvals`, or, for a call with a
  subject, the tool and subject in `session_subject_approvals`.
- `always` writes the global setting so that the tool no longer asks, or, for a
  call with a subject, a grant for that tool and subject.

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
8. **Messages from the user.** `POST /api/runs/:id/messages` with `{ text }`
   queues a message on a running subagent's run (`ActiveRun.userMessages`, at
   most 5 waiting, at most 4,000 characters; the response is
   `{ waiting }`). The loop takes the queue at the start of its next step (see
   core.md). The backend adds `subagentMessageLabel` and a blank line before
   each text when the loop takes it, so a change to the setting applies to
   messages already waiting. The message is saved, linked to the child's run,
   when the loop takes it, so the transcript stays in order, and a
   `user.message` event follows. 404: no such run. 409: the run is not active
   or 5 messages are already waiting. 400: empty or too long text, or a
   top-level run. A message still waiting when the run ends is dropped, never
   stored. The snapshot of an active run lists its waiting texts
   (`userMessages`). The parent run is not told.

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

### Branches

A session's transcript is a tree. Each top-level message has a `parent_id`, and
the session's `tip_id` is the last message of the line it shows. Messages of
subagent runs have no parent; `anchor_id` points at the top-level assistant
message holding the root `start_subagent` call, and they are shown with the line
through that message. `last_child_id` remembers which continuation was last
viewed so switching lands on it. `trashed_at` on the first message of a deleted
branch hides everything under it until it is restored or purged (after
`trashRetentionDays`, counted from the deletion).

Editing, regenerating and branching only move the tip or add a sibling; nothing
is rewritten except an `in_place` edit of the text. A branch may only start or end
at a _complete point_ (a user message, an `edit` message, an assistant message
without tool calls, or the last tool result of a group), see `branches.ts`. The
`editMode` setting (`HARNESS_EDIT_MODE`) picks the default for an edit and
`answerAfterEdit` whether the model replies to a branched edit. Every change
publishes `session.transcript_changed` so open pages reload. `GET
/api/sessions/:id` returns `branching` (points, editable messages, the turn
Regenerate would redo, and continuations after the tip). **Forking** (`fork.ts`, `RunManager.fork`) copies, in one transaction, the line
up to a complete point and the branches that leave it earlier (not deleted
ones, nor anything after the point) into a new session with new ids: messages
with their subagent messages, the runs that wrote them with their
`run_messages`, and those runs' events with `messageId` and `parentRunId`
rewritten (events about messages after the point are dropped). It also copies
the model, effort, agent and project, media choices, session tool and subject
approvals and workspace attachments. Files, notes and data belong to the
project or global scope and are shared, and blobs are shared by hash. The new
session records `forked_from_id` and the title the source had; the session
detail returns `forkedFrom` with `state` `live`, `trashed` or `gone`. A new
event field that holds a message or run id must be added to the lists in
`fork.ts` (a test checks every event type). Workspace file
snapshots are not part of this yet: moving the tip leaves files as they are.

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

### Folders

A file's key can contain `/`, so files form a tree. A folder that holds files
needs no record. An **explicit folder** is a row in `folders` (`project_id`
null for global, `path`) that lets an empty folder exist. Session folders are
kept in the transcript, like session files. Renaming a folder writes each file
inside it under its new key (a new version) and deletes the old key, and moves
explicit folder rows to match; deleting a folder deletes the row and
soft-deletes the files inside it, so they can be restored. Folder and file
names follow core's name rules (`file-names.ts`).

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
- **Results.** Text is passed on. An image or audio block (or a binary resource
  with a media type) is saved as a session file when it is a type llama-server
  reads and is under 20 MB (see [Media in requests](#media-in-requests));
  otherwise it is named and left out. A result the server marks as an error
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
404 not found, 409 conflict, 502 llama-server unreachable). A 400 for an invalid
request also lists the `issues`.

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

| Method and path                                                         | Purpose                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/sessions?projectId=`                                          | List sessions (a project's, or standalone).                                                                                                                                                |
| `GET /api/sessions-page`                                                | One page of sessions for the Sessions page: `projectId`, `direction` (`asc`/`desc` by creation time), `page`, `pageSize` (10, 25, 50 or 100). Each item says whether a run is in progress. |
| `GET /api/sessions-page/ids`                                            | The ids of every session not in the trash (a project's, or standalone) and whether each is running: what "select all" needs.                                                               |
| `POST /api/sessions/trash`                                              | Trash several sessions (`{ ids }`). The ones that cannot be trashed (not found, already trashed, a run in progress) come back with the reason.                                             |
| `POST /api/sessions`                                                    | Create (optionally in a project; applies the default agent).                                                                                                                               |
| `GET /api/sessions/:id`                                                 | Session detail: session, project, the messages of the line shown (each with its sibling branches), `branching`, `forkedFrom`, subagent usage, and the live-run snapshot.                   |
| `PATCH /api/sessions/:id`                                               | Rename, or change model, effort or agent.                                                                                                                                                  |
| `POST /api/sessions/:id/trash`, `…/restore`, `DELETE /api/sessions/:id` | Trash, restore, permanently delete (trashed only).                                                                                                                                         |
| `GET /api/sessions/:id/debug`                                           | Debug export.                                                                                                                                                                              |
| `GET /api/trash`, `DELETE /api/trash`                                   | List the trash (projects, sessions, deleted branches); empty it.                                                                                                                           |
| `PATCH /api/sessions/:id/messages/:messageId`                           | Edit a user message (`mode` `branch` or `in_place`); see [Branches](#branches).                                                                                                            |
| `POST /api/sessions/:id/regenerate`, `…/branch`, `…/switch`             | Regenerate the last reply; end the line at a message; show another branch.                                                                                                                 |
| `POST /api/sessions/:id/fork`                                           | Copy the line up to a message into a new session (201); body `{ messageId, title }`.                                                                                                       |
| `DELETE /api/sessions/:id/branches/:messageId`                          | Move a branch to the trash.                                                                                                                                                                |
| `POST /api/trash/branches/:messageId/restore`, `DELETE …/:messageId`    | Restore a deleted branch; delete it forever.                                                                                                                                               |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`                 | List, create, read, update projects.                                                                                                                                                       |
| `POST /api/projects/:id/trash`, `…/restore`, `DELETE /api/projects/:id` | Trash, restore, permanently delete.                                                                                                                                                        |

### Runs

| Method and path                                              | Purpose                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/messages`                            | Send a user message and start a run (202 with `{ runId }`). Body may carry `model`, `reasoningEffort`, `agentId`. |
| `POST /api/sessions/:id/continue`                            | Continue the last message or take the next step.                                                                  |
| `POST /api/runs/:id/cancel`                                  | Cancel a run (and its children).                                                                                  |
| `POST /api/runs/:id/end-reasoning`                           | Ask the model to stop thinking and answer.                                                                        |
| `POST /api/runs/:id/messages`                                | Send a message to a running subagent; it reads it at its next step (`{ text }`; 200 with `{ waiting }`).          |
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
| `/files`, `/files/:key`, `/notes`, `/notes/:id` (plus `/restore`) | global, project, session        | List, read, write, update, delete, restore files and notes. `POST /files` uploads a binary file.                   |
| `/folders`, `/folders/rename`, `/folders/delete`                  | global, project, session        | List, create, rename and delete explicit folders of files (see [Folders](#folders)).                               |
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

| Event                | Meaning                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mcp.changed`        | An MCP server was created, saved or deleted, or its connection or tools changed.                             |
| `workspaces.changed` | A workspace, an attachment or a grant changed.                                                               |
| `agents.changed`     | An agent was created, saved, deleted, restored or imported (includes sessions whose agent pick was cleared). |
| `skills.changed`     | A skill changed.                                                                                             |
| `data.changed`       | Global, project or agent schemas or data changed.                                                            |
| `projects.changed`   | A project was created by a tool.                                                                             |
| `errors.changed`     | An error was recorded, or errors were cleared.                                                               |

Because they are not replayed, a client refetches what it shows whenever the
stream opens or reopens.
