# How the Parts Work Together

This document follows real scenarios through the whole system. Read
[glossary.md](glossary.md) first if a term is unfamiliar.
[worked-example.md](worked-example.md) traces one complete conversation in detail.

## The layers

```
UI (frontend)           shows state, sends user actions, follows events
   │  HTTP requests ▲  events (SSE)
   ▼                │
Routes (backend)        validate, then call the RunManager or a store
   │
RunManager (backend)    starts runs, stores every event and message,
   │                    holds open approvals and forms
   ▼
runLoop (core)          model → tools → model … ; emits events
   │            │
   ▼            ▼
LlamaServerAdapter    Tools (tools package)
   │                     │ use ToolContext interfaces
   ▼                     ▼
llama-server          Stores / SQLite (implementations supplied by the backend)
```

Three rules explain most of the design:

1. **Calls go down, events come up.** The UI sends commands over HTTP. Progress
   comes back only as events.
2. **Store, then send.** The backend writes each event and each message to the
   database before anyone sees it.
3. **Core asks, the backend answers.** Core never reads a table. When a tool needs
   project files, the loop calls an interface the backend implemented.

## Scenario 1: sending a message

The user types "Draft chapter one" in a session and presses Send.

**1. UI → backend.** `POST /api/sessions/:id/messages` with the text and the
session's chosen model, effort and agent.

**2. Backend starts a run.** `RunManager.sendMessage`:

- confirms no run is active in this session;
- saves the choices on the session;
- appends the user message to `messages`;
- calls `launch`, which resolves the agent, skills and tools, composes the system
  message, inserts a `runs` row (with the system message and tool list), builds the
  request (system message + the session's messages), and starts `runLoop`;
- returns `202 { runId }` right away.

**3. UI.** The send mutation refetches the session, showing the stored user
message. The page has already opened the session's event stream, so the run's
events start arriving.

**4. Core runs the loop.** Each time something happens, core calls `emit`. The
backend's `emit` inserts the event into `events` (getting its id) and delivers it
to every open stream for the session.

A typical sequence of events for a run with one tool call:

```
run.started
step.started            (index 0)
message.started
reasoning.delta …       (live thinking)
text.delta …
tool.called             (the model asked for files_write)
message.finished        (assistant message stored, finishReason tool_calls)
tool.approval_requested (if the tool asks)
tool.approval_resolved
tool.result             (tool result message stored)
step.finished
step.started            (index 1: the model sees the result)
message.started
text.delta …
message.finished        (finishReason stop)
step.finished
run.finished            (reason stop, total usage)
```

**5. UI follows the events.** `useSessionEvents` applies `text.delta` and friends to
the live message with `applyMessageEvent`, so text appears as it streams.
On `message.finished` the stored message replaces the live one. On `tool.result`
the session is refetched so the tool result appears. On `run.finished` the live
file is cleared and lists are refreshed.

**6. Title.** If this was the session's first message and it still has the default
title, a background job (started in step 2) writes a title and emits
`session.renamed`, which the UI applies to the navbar.

## Scenario 2: one model call, in detail

Inside `runLoop`, one step:

1. `streamMessage` calls `LlamaServerAdapter.stream` with the transcript.
2. The adapter folds edit messages and decision comments into user text, converts
   messages to OpenAI shape, and `POST`s to llama-server's `/v1/chat/completions`.
3. llama-server streams chunks. The adapter yields `reasoning`, `text` and `usage`
   chunks immediately, and collects tool-call fragments.
4. `streamMessage` turns chunks into events and builds the assistant message. At
   the end the adapter yields complete `tool_call` chunks and a `finish`.
5. `beforeFinished` → `onMessage` → the backend upserts the message row, links it
   to the run in `run_messages`, then core emits `message.finished`.
6. The loop runs each tool call in order (next scenario).
7. If the model produced no tool calls the run is over; otherwise the next step
   begins with the tool results in the transcript.

## Scenario 3: a tool that needs approval

The model calls `data_create` (approval default `ask`).

**Core.**

1. The loop validates the arguments.
2. `needsApproval` (backend) says the tool asks: no always-allow, no agent
   override, not allowed for the session.
3. The tool declares `review`, so the loop calls it to compute the planned change
   without saving anything.
4. The loop emits `tool.approval_requested` (with the review) and **waits** on the
   `approve` promise.

**Backend.** The `approve` callback stores the request in the active run's open
approvals and returns a promise that has not resolved. The event is persisted and
streamed like any other.

**UI.** The event adds the request to `useLive`; `ApprovalDialog` opens. The user
unticks one change and presses _Allow once_. The UI first calls `…/check` to
make sure the remaining selection is valid, then `POST
/api/runs/:id/approvals/:requestId` with `{ choice: "once", selection }`.

**Backend.** `answerApproval` validates (choice allowed for this tool, no stale
data, selection applicable), removes the request, and resolves the promise.

**Core.** The loop emits `tool.approval_resolved`, passes the selection to the
tool through `ctx.approval`, and executes the tool. The tool applies only the
approved changes. The result is stored and `tool.result` is emitted.

If the user presses _Allow for this session_, the backend records the tool in
`session_tool_approvals`; _Always allow_ changes the global per-tool setting.

If the run is cancelled while the dialog is open, the abort signal makes the loop
stop waiting, emit `request.cancel`, and answer the call "Not run: the run was
cancelled."

## Scenario 4: files and the transcript

How is a **session-scoped** file saved? There is no files table for a session.

1. The model calls `files_write` with scope `session`. The tool calls
   `ctx.files.writeFile("session", key, type, value)`.
2. `createFileAccess` applies the change to its in-memory copy of the session's
   files and appends an `FileOp` (`put`) to a list.
3. The tool returns successfully, so the loop stores the tool result message **with
   `files: [that op]`**. (If the tool had failed, the op would be discarded.)
4. The backend notices `message.files` and updates the search index.
5. On the next call, `replaySessionFiles(allSessionMessages)` starts empty and
   applies every op from every message in order. The file exists again.

Project and global files differ: `ctx.files` calls `SharedFiles.put`, which the
backend implements as an SQL write to `files` plus a new row in
`file_versions`, with the model as author.

When the **user** edits a session file in the UI, the request goes to
`PUT /api/sessions/:id/files/:key`. The backend appends an `edit` message with the
op and a notice such as `[The user changed session file chapter1.md in the app.]`,
and emits `session.files_changed`. The next model call sees the notice in a
user message, and replay applies the op.

Why this design: a session's state is exactly its transcript, so it can never
disagree with it, copying or exporting a session carries its state, and deleting
the session deletes it.

## Scenario 5: a subagent

The Dispatcher agent receives "I need a character sheet" and calls
`start_subagent` with a specialist's id and a task.

1. The loop runs the call. `start_subagent` checks the agent is startable and calls
   `ctx.subagents.start`, implemented by `RunManager.startChild`.
2. `startChild` calls `launch` for the specialist with `parent = { runId, callId }`.
   The child gets its own run row with `parent_run_id` and `parent_call_id`, its own
   system message (including the child line), and its own tool set (it is offered
   `subagent_handback`; it is offered `start_subagent` only if the depth limit
   allows).
3. The task is saved as the child's first user message. The child's request is
   _only_ its own messages.
4. The child run emits events on the **same session stream**; `run.started`
   carries `parentRunId` and `parentCallId`. The parent's loop is suspended,
   awaiting the child's result.
5. In the UI, `useLive` adds a **child** file under the top-level run, and the
   transcript shows a panel under the `start_subagent` call with the child's
   messages and any prompts it raises. Approvals and forms the child opens are
   answered against the **child's run id**.
6. The child calls `subagent_handback("…")`. The tool returns `handback` text,
   and the child's loop ends with reason `handed_back`.
7. `startChild` turns that into `{ ok: true, agent, output }`. `start_subagent`
   returns it as the parent's tool result, and the parent continues.

If the child forgets to hand back, it gets up to `childReminders` reminder
messages, and finally its last text is used as the output. If the user presses
Cancel, the cancel request resolves to the root run, and the abort signal reaches
the child.

While the child works, the user can send it a message from its panel
(`POST /api/runs/:id/messages`). The message waits in a queue on the child's run.
At the start of the child's next step the loop takes it, stores it with the
setting `subagentMessageLabel` in front, and adds it to the child's transcript as
a user message. The step that was running is not interrupted. If the child would
stop or hand back while a message waits, it gets one more step to read it. The
parent does not see the message.

Files, schemas and data the child wrote in the session scope are rebuilt
from the whole session's messages, so the parent sees them.

## Scenario 6: reconnecting

The user reloads the page mid-run, or the laptop sleeps and the stream drops.

**Reload.**

1. `GET /api/sessions/:id` returns the stored messages and the **snapshot**: the
   last event id, and for each active run its in-flight message (rebuilt by
   replaying that run's stored events), its open approvals and open forms.
2. The UI seeds `useLive` from the snapshot, so the half-written text and any
   pending approval dialog reappear immediately.
3. It opens the stream with `lastEventId` from the snapshot. The backend replays
   stored events after that id, then goes live.

**Dropped stream.** `EventSource` reconnects by itself and sends `Last-Event-ID`.
If the browser gives up (for example a proxy error while the backend restarts),
`useSessionEvents` opens a new `EventSource` from the last id it handled, with
exponential backoff. The server writes the backlog and registers the live
listener in the same synchronous step, so nothing is dropped or duplicated.

**App events** are not replayed, so `useAppEvents` refetches agents, skills, data,
projects, errors and the active runs each time its stream opens.

## Crash and shutdown recovery

**Clean shutdown** (`SIGINT`/`SIGTERM`): the backend aborts every active run and
waits. Streams end as `interrupted`; whatever text was produced is saved, and
tool calls that did not run get "Not run: the backend was stopped."

**Crash** (power loss, killed process): the database still says `running` for the
active runs. On the next start `recover()`:

1. rebuilds each half-written assistant message from its stored events and saves it;
2. withdraws open approvals and forms with `request.cancel`;
3. adds "Interrupted…" error results for tool calls that had no result, without
   re-running them;
4. marks each run `interrupted` and emits `run.interrupted`.

The transcript is always valid (every call has a result), so the user can press
_Continue_ or send a new message. Each event is stored before it is sent, and each
message before its event, so nothing a client saw is lost.

## Scenario 8: what the model sees

For any model call, the request is:

```
system message          composed at launch (global + project + agent prompts,
                        skill/tool/schema/data lists, files instruction,
                        subagent line)
… the session's messages, in order, with
   edit messages folded into user text,
   decision comments folded into user text,
   tool results as role "tool"
tools                   the run's tool definitions (name, description, JSON Schema)
```

Not sent: tool results' `data`, `state`, `files`, `dataOps` and `prompt` fields,
or any event. Those exist for the harness and the UI. The exact system message and
tools of every run are saved on the run, and the Debug tab shows them.

## Scenario 9: a settings change

The user changes `loopLimit` in Settings.

1. `PUT /api/settings` validates and stores the value in `settings`; the embedder
   is told that settings changed.
2. The response returns effective values, stored values and which are overridden
   by environment variables.
3. A run already in progress keeps the value it started with. The next `launch`
   reads the settings again.

An environment variable beats a stored value, so the page marks such a setting as
overridden and the stored value stays dormant until the variable is removed.

## Where to look for what

| Question                                  | Look at                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| What events can a run emit?               | `core/src/events.ts`                                               |
| What happens when the model calls a tool? | `core/src/loop.ts`, `runCall`                                      |
| How is a tool defined?                    | `core/src/tools.ts`, `tools/src/*.ts`                              |
| How are runs started and recorded?        | `backend/src/runs.ts`, `launch`                                    |
| How is the system message built?          | `backend/src/runs.ts` (composition), `backend/src/placeholders.ts` |
| What is in the database?                  | `backend/migrations/*.sql`, `backend/src/store.ts`                 |
| How does streaming reach the browser?     | `backend/src/server.ts` (event routes), `frontend/src/live.ts`     |
| How does the UI show a prompt?            | `frontend/src/routes/ApprovalDialog.tsx`, `AskUserForm.tsx`        |
| How does search work?                     | `backend/src/search*.ts`, `embedder.ts`, `core/src/chunking.ts`    |
| How does model communication work?        | `core/src/llama-server/adapter.ts`                                 |
| How do workspaces and MCP tools work?     | `backend/src/workspace-*.ts`, `mcp-manager.ts`                     |
| How do I make a change?                   | [contributing.md](contributing.md)                                 |
