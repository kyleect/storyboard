# Glossary

Terms are grouped by theme. Each entry points to the document that explains it
in depth.

## Conversation structure

**Session**
One conversation. It has a title, an optional project, an optional chosen
agent, an optional model and reasoning effort, and an ordered transcript. A
session is either _standalone_ (no project) or belongs to exactly one project,
fixed when it is created. Stored in the `sessions` table.

**Project**
A named container for sessions. A project has a description, an optional
color (a name from a fixed palette, shown on its folder in the UI), an optional
system prompt, an optional default agent, and its own files, agents,
skills, schemas and data that all of its sessions share. Stored in `projects`.

**Transcript**
A session's messages in order. It is the source of truth for the conversation
and for session-scoped files, schemas and data. Stored in `messages`.

**Message**
One file in a transcript. Messages are provider-neutral and have one of five
roles: `system`, `user`, `assistant`, `tool` and `edit`. See
[core.md](core.md#messages).

**Assistant message**
A message from the model. Its content is a list of _blocks_: `text`,
`reasoning` and `tool_call`.

**Tool result message** (role `tool`)
The outcome of one tool call. It carries the text the model sees and also
harness-only data: structured result, saved tool state, file and data changes,
the user's decision comment, and the form the tool showed.

**Edit message** (role `edit`)
A record that _the user_ changed session-scoped files, schemas or data
in the UI. It has a one-line notice the model reads and the list of changes
used for replay.

**Content block**
One part of an assistant message: `text`, `reasoning` (the model's thinking),
or `tool_call` (a request to run a tool).

## Execution

**Run**
One execution of the agent loop for a session: the model is called, tools run,
and the model is called again, until it stops. A run has an id, a status, a
start and end time, a model, a reasoning effort, an agent version and a token
usage total. Stored in `runs`. A session has at most one active top-level run
at a time.

**Top-level run**
A run started by a user action (sending a message, or continuing). Contrast
with a _child run_.

**Child run / subagent run**
A run started by the `start_subagent` tool call of another run (its _parent_).
It is stored as a run of its own with `parent_run_id` and `parent_call_id`
set. See [backend.md](backend.md#subagents).

**Subagent**
An agent that runs as a child run. Only agents marked `subagent: true` can be
started this way.

**Message to a subagent**
A message the user types in a running subagent's panel. It waits in a queue and
is read at the start of the subagent's next step, as a user message with
`source: "user"`. See [backend.md](backend.md#subagents).

**Handback**
How a subagent ends: it calls `subagent_handback` with its output, which ends
its run and becomes the result of the parent's `start_subagent` call.

**Step / iteration**
One model call inside a run, plus the tool calls that follow it. Steps are
numbered from 0. The _loop limit_ caps how many a run may make.

**Loop limit**
The most model calls one run makes (setting `loopLimit`, default 20). A run
that reaches it ends with reason `iteration_limit`.

**Run status**
`running`, `finished`, `failed`, `cancelled` or `interrupted`.

**Interrupted**
A run that was active when the backend stopped. Its partial work is saved and
the run is closed as `interrupted`. See
[how-it-works-together.md](how-it-works-together.md#crash-and-shutdown-recovery).

**Continue**
Starting a run that extends the last message instead of adding a user message:
after an assistant message without tool calls, the model continues that
message (prefill); after a tool result, the run takes the next step.

**Generation**
The model, reasoning effort and agent version a run used. It is recorded on the
run and on each assistant message it wrote.

**Model / reasoning effort**
The model name sent to llama-server (relevant in router mode) and the
`reasoning_effort` value (`none` turns reasoning off; other values such as
`low` are passed to the chat template). Each session can choose its own;
otherwise the settings supply defaults.

**Usage**
Token counts `{ promptTokens, completionTokens }` for a model call or a whole
run. The latest call's usage measures how full the context is.

## Events and streaming

**Event**
A small typed record of something that happened during a run, such as
`text.delta` or `tool.result`. Events are the only way a run reports progress.
See [core.md](core.md#events).

**Envelope**
The fields every event carries: `runId`, `sessionId` and `time`.

**Stored event / replay id**
An event after the backend has saved it, with an increasing integer `id`. The
id is used as the SSE event id, so a client can resume after the last one it
saw.

**Session event**
An event that belongs to a session but to no run (`runId` is `null`), such as
`session.renamed`. Stored and replayed like run events.

**App event**
A notification sent to every open window on `/api/events` (for example
`agents.changed`). Not stored and not replayed.

**SSE (server-sent events)**
The one-way streaming protocol the backend uses to push events to the browser.

**Snapshot**
What `GET /api/sessions/:id` returns about live runs: the last event id, the
in-flight message of the active run (rebuilt from stored events), and any open
approvals and forms. A client starts from the snapshot, then follows the
stream.

**Live run**
The frontend's in-memory view of a run in progress, built from the snapshot
and streamed events.

## Tools and approval

**Tool**
A function the model can call. It has a name, a description, an input schema
(Zod, sent to the model as JSON Schema) and an `execute` function. See
[tools.md](tools.md).

**Tool call**
A request by the model to run a tool, with arguments. Stored as a `tool_call`
block of an assistant message.

**Tool state**
Optional data a tool saves with its result. The latest state a tool saved in
the transcript is given back to it on its next call.

**Approval default**
A tool's own rule for asking the user before running: `ask`, `never`, or
`always`.

**Always-asks tool**
A tool whose approval default is `always`. It asks on every call and its
setting cannot be changed; the prompt offers only _Allow once_ and _Deny_.

**Approval request**
The prompt shown when a call needs approval. Answers: _once_, _session_
(allow this tool for the rest of the session), _always_ (stop asking for this
tool globally) and _deny_. A _decision comment_ can be attached to _once_ and _deny_.

**Decision comment**
The text a user types on an approval prompt when allowing a call once or
denying it. It is stored on the call's tool result as `decisionComment` and sent
to the model as a user message after the turn's results.

**Guidance**
A field named `guidance` in a tool result's `data`: a short remark from the tool
to the model, for example that the user changed the scope it suggested.

**Agent approval setting**
A per-agent override saying a particular tool does (or does not) ask when that
agent runs. It outranks the global tool setting but not an always-asks tool.

**Review**
For tools that can describe their changes before committing them (the schema
and data tools), the approval request carries a _review_: each item with its
before and after values and the individual changes. The user can approve a
subset by sending a _selection_.

**Form / input request**
A set of questions shown to the user in the chat, produced by the `ask_user`
tool or by another tool. The run waits for the answers. A form can be
_answered_ or _skipped_.

**Malformed call**
A tool call whose arguments were not valid JSON. It is kept in the message and
answered with an error result so the model can retry.

**Errors console**
The pages and panels that list recorded tool errors and failed runs.

## Agents and prompts

**Agent**
A named bundle of: a system prompt, a tool grant, per-tool approval
settings, and subagent settings. It is global or belongs to a project. A
session can pick an agent; a run uses the agent version current when the run
starts.

**Agent version**
Each save of an agent adds a version. Runs and assistant messages record which
version they used.

**Tool grant**
How an agent selects tools: a mode (`allow` or `deny`), groups, exceptions and
extras, plus the tools that existed when the version was saved. See
[backend.md](backend.md#tool-grants).

**Tool group**
A set of related tools (Files, Workspaces, Structured Data, Projects,
Agents, Subagents, Sessions, Skills, Web, MCP, Utilities). Every tool is in exactly one. An
agent can be given or refused a whole group. See [tools.md](tools.md#tool-groups).

**Always-on tools**
Tools offered to every agent regardless of its tool grant. A tool's own default
can be changed in Settings. By default: `skill_load` and `subagent_handback`. The
file tools are in tool groups, so an agent gets them through its grant.

**Needs-review tool**
A destructive or prompt-changing tool that a group grant does not cover; an agent
has it only when it is listed on its own.

**Off tool**
A tool switched off in Settings for the whole harness. No run is offered it.

**Dispatcher**
The built-in agent that greets the user and hands work to a specialist
subagent. It is the default agent when nothing else is chosen.

**Derived text**
The description or transcript of an image or audio file, kept with its bytes.
The Media Describer writes it when the file is added (if a model is chosen in
Settings), or the user types it. It is searched, and it is what a model that
cannot see or hear the file is given.

**Media Describer**
The built-in agent whose prompt writes derived text. It can also be started as
a subagent.

**Workspace**
A named folder on the user's computer that a project or session can attach,
read-only or writable. Its files are named `workspace://<id>/path`. Agents read
it with the workspace tools and change it only with approval, per workspace.

**Ticks**
The parts of a workspace the user chose to search: paths inside the folder, where a
ticked folder covers what is below it. Ticked text files are indexed; the rest of
the workspace is still reachable by listing and reading.

**Approval subject**
What a tool call is about, such as the workspace a path is in. Approvals and
"Always allow" are remembered per tool and subject.

**Built-in**
A record shipped with the app and read-only: the Dispatcher and Media Describer
agents, the Task,
Goal and Decision schemas, and four skills. Built-ins form a scope of their
own, so a user can create a record with the same name.

**System prompt**
The system message sent first on every model call. It is composed from the
global prompt, the project prompt, the agent prompt, and generated lists and
instructions. See [backend.md](backend.md#the-system-message).

**Placeholder**
A token in a prompt the user writes: `{{skills}}`, `{{tools}}`, `{{schemas}}`,
`{{data}}`, `{{agents}}`, `{{workspaces}}`, `{{files}}`, the `…_instruction` of
each (such as `{{skills_instruction}}`), `{{date}}` or `{{time}}`. It is replaced when a run
starts with what that run has, or with the date or time then. Prompts are
Mustache templates, so a placeholder can also be a condition:
`{{#skills}}…{{/skills}}` is kept only when there are skills.

**Skill**
A folder of written instructions and other files, following the Agent Skills
layout: a `SKILL.md` (frontmatter with `name` and `description`, then the
instructions) plus any other files. The system message lists each skill with its
description; the model loads one with `skill_load` and reads its other files
with `skill_load` and a `path`. Skills are built-in, global, project or agent
scoped.

## Files, schemas and data

**Scope**
Where a record lives and who sees it. Files have three scopes:
_session_, _project_, _global_. Schemas and data have four: _session_,
_project_, _agent_, _global_ (schemas also have _builtin_). Skills have _builtin_,
_global_, _project_ and _agent_.

**File**
A named document with a key such as `characters/alice.md`. A text file is
`plain`, `markdown` or `json`; an image or audio file is a _binary file_. A key
is a path of names separated by `/`; names are case-sensitive and follow the
rules in [core.md](core.md#file-names-and-references).
Written by both the user and the model.

**Folder**
The `/`-separated part of a file's key. A folder with files needs no record; an
_explicit folder_ (a row for project and global files, a transcript file for
session files) lets an empty folder exist. See
[backend.md](backend.md#folders).

**File reference**
Text that says where a file is: `session://notes.md`, `project://…`,
`global://…` or `workspace://<id>/path`. Written in angle brackets in messages
and tool results. See
[core.md](core.md#file-names-and-references).

**Binary file (blob)**
An image or audio file. Its bytes are stored once, by SHA-256, in the `blobs`
table; the file record points at them. See
[backend.md](backend.md#binary-files-and-attachments).

**File version**
Every change to a project or global file adds a version with its author
(`user` or `model`). A delete is a version.

**Schema**
A named, versioned JSON Schema describing the shape of structured data (for
example a task).

**Schema version**
Each change to a schema's body adds a version. Renaming does not.

**Data**
A JSON value that conforms to one version of a schema, with a name and
description. Data is _pinned_ to the schema version it was made from until it
is migrated.

**Migration**
Moving data to a newer schema version, with defaults filled in and an optional
merge patch applied.

**Merge patch**
An RFC 7396 JSON Merge Patch, used by `data_update` and `data_migrate`.

**Branch / tip**
A session's transcript is a tree: each top-level message points at the one before
it (`parent_id`). The page shows one line of it, from the first message to the
session's _tip_ (`tip_id`). Editing, regenerating or branching off adds a sibling
or moves the tip instead of rewriting messages, and a branch can be switched to,
deleted (to the Trash) and restored. See [backend.md](backend.md#branches).

**Fork**
Copies a session's line up to a message into a new session, with new ids. Files,
data are shared with the source because they live in the project or
global scope. See [backend.md](backend.md#branches).

**Replay**
Rebuilding session-scoped files, schemas and data by applying, in order,
the changes recorded on the session's messages.

**Chunk**
A piece of a file used for search. Files are split at about 1,500 characters.

**Embedding**
A vector for a chunk, produced by an embedding model on llama-server, used for
meaning-based search.

## Operations

**Settings**
Configuration values stored in the database and editable in the UI, each
overridable by an environment variable.

**Trash**
Sessions, projects and deleted branches of a transcript are moved here before deletion. Items older than the
retention period are purged at backend startup.

**Token (API token)**
The secret the UI sends with every request. Distinct from a _model token_.

**Data directory**
The folder holding the database, key file, API token and runtime file.

**MCP server**
An external program or remote service the backend connects to as an MCP client;
its tools become harness tools in the `mcp` group, named `mcp_<server>_<tool>`.
See [backend.md](backend.md#mcp-servers).

**Data step**
A one-time change to stored data that SQL cannot make (for example rewriting JSON
inside messages), run once after the migrations and recorded in `data_steps`. See
[backend.md](backend.md#migrations).

**Migration (database)**
Not to be confused with a data migration. A numbered `.sql` file that changes
the database schema. See [backend.md](backend.md#database-and-migrations).
