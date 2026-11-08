# Core (`@harness/core`)

Core is the engine of the harness. It knows how to turn a transcript into a
model request, stream the response, run the model's tool calls, and report
everything as events. It does not know about databases, HTTP or the UI.

Anything core needs from the outside world is declared as an interface and
passed in by the caller (the backend). This keeps core testable with a
scripted model and in-memory fakes.

```
packages/core/src
  messages.ts            message and content-block types (Zod)
  events.ts              the event contract (Zod)
  model.ts               ModelAdapter interface, request and chunk types
  run.ts                 streamMessage, runSingleCall
  loop.ts                runLoop: the agent loop
  tools.ts               Tool, defineTool, ToolContext, access interfaces
  forms.ts               input forms: reading, validating, describing
  entries.ts             files and memory notes: access API, replay
  schemas-data.ts        schemas and data: access API, replay
  schema-features.ts     the JSON Schema subset schemas may use
  review.ts, changes.ts  describing and applying proposed changes
  notes.ts               approval notes folded into user messages
  chunking.ts            splitting file text for search
  control.ts             RunControl: act on a streaming response
  message-state.ts       rebuild a message from events
  fake-model.ts          ScriptedModel for tests
  llama-server/          adapter, models, props, embeddings, SSE reader
  testing.ts             test helpers exported as @harness/core/testing
```

## Messages

`messages.ts` defines the provider-neutral transcript format. Model adapters
translate to and from it.

| Role        | Shape                            | Meaning                                                                                                                                                                                                           |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`    | `{ content }`                    | System prompt. Added per request by the backend; not stored in the transcript.                                                                                                                                    |
| `user`      | `{ content, files?, source? }`   | What the user typed, with references to any images or audio sent with it, or a task, reminder or user message given to a subagent. `source` (`task`, `reminder`, `user`) says which; it is not sent to the model. |
| `assistant` | `{ content: ContentBlock[] }`    | What the model produced.                                                                                                                                                                                          |
| `tool`      | see below                        | The outcome of one tool call.                                                                                                                                                                                     |
| `edit`      | `{ content, entries, dataOps? }` | The user edited session files, notes, schemas or data.                                                                                                                                                            |

**Content blocks** of an assistant message:

- `text`: `{ text }`
- `reasoning`: `{ text }`, the model's thinking
- `tool_call`: `{ callId, name, arguments }`. If the arguments were not valid
  JSON, `arguments` keeps the raw string so the call can be answered with an
  error.

**Tool result** (`role: "tool"`) fields:

| Field            | Sent to the model? | Purpose                                                                  |
| ---------------- | ------------------ | ------------------------------------------------------------------------ |
| `callId`, `name` | yes (id)           | Which call this answers.                                                 |
| `content`        | yes                | The serialized result text.                                              |
| `isError`        | no                 | Marks a failed call. The run continues.                                  |
| `data`           | no                 | The tool's structured result.                                            |
| `state`          | no                 | State the tool saved; the latest one is returned to it on its next call. |
| `entries`        | no                 | Changes the call made to session-scoped files and notes.                 |
| `dataOps`        | no                 | Changes the call made to session-scoped schemas and data.                |
| `note`           | yes, indirectly    | The text the user typed on the approval prompt.                          |
| `prompt`         | no                 | The form the tool showed and how it was answered.                        |

`ModelMessage` is `Message` without `edit`. Before a request is sent, edit
messages are converted to user text (see below).

**Files.** A user message can carry `files`: references to images and audio
(`session://cat.png`, `project://…`, `global://…`). The message stores only the
reference; kind, type and size are looked up from the file. The bytes are kept by
the backend, and the request that is sent to the model carries a
`resolveFile(ref)` function that returns the file's kind, media type and bytes
as base64 (or `undefined` when it is gone, in which case the model is told the
file is no longer available). A binary file is a file with a binary media type
and a `blob` (`{ hash, size }`) in place of a value; session files record it in a
`put` operation.

### Media in a request (`media.ts`)

A message names images and audio by reference; `foldMedia(messages, policy)`
(first in the adapter's pipeline) decides what is inline in each request. A
_turn_ is a user message and everything the agent does until the next one
(a `reminder` user message does not start one).

- Media of the current turn is always inline: the last user message's `files`,
  and the `media` of tool results after it (`ToolResultMessage.media`, set when
  a tool returns `ToolOutput.media`).
- Older media is a text line, `[Attached: <ref> (type)]`, unless it is kept.
  Keeping goes by the user's choice for that file, else the agent's `keep` when
  it read the file, else `keepDefault`. At most `cap` kept items from earlier
  turns are inline (the newest); the rest are text.
- A file that is gone is named `(no longer available)`; a kind the model cannot
  read (`MediaSupport`, from `inputModalities`) is named as one it cannot view
  and never sent.
- A tool message can only hold text, so a turn's tool media goes in a user
  message after the turn's results, headed "Media from the tool results above:"
  (or at the start of the user message that follows them).

`ChatRequest.media` carries the policy; without it messages are unchanged.

### Folding edits and notes into user text

Models should not see two user messages in a row because of harness
bookkeeping. Before sending, the adapter applies two transforms:

- `foldNotes` (`notes.ts`): the approval notes attached to one turn's tool
  results become one user message after the last result, headed "Notes on this
  turn's tool calls:", with one line per note. If a user message follows, the
  notes go at the start of it instead.
- `foldEdits` (`entries.ts`): a run of consecutive `user` and `edit` messages
  containing at least one edit becomes a single user message. An edit's text is
  a notice such as `[The user changed session file chapter1.md in the app.]`.

Both keep the `files` of the user messages they fold, in order, so a
message that was joined to an edit or to notes does not lose its files.

## Events

`events.ts` is the contract between core, the backend (which stores and
streams events) and the UI. Core emits events _without_ an `id`; the backend
assigns the increasing `id` when it stores them.

Every run event has an envelope: `{ runId, sessionId, time }` (ISO 8601).
Session events have `runId: null`.

### Run events

| Group   | Event                              | Data                                                                                                               |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Run     | `run.started`                      | `kind`, `model?`, `reasoningEffort?`, `agent?`, `parentRunId?`, `parentCallId?`                                    |
|         | `run.finished`                     | `reason`: `stop`, `iteration_limit`, `cancelled`, `handed_back`; `usage?`                                          |
|         | `run.failed`                       | `error`                                                                                                            |
|         | `run.interrupted`                  | (empty) The backend stopped while the run was active.                                                              |
| Step    | `step.started`, `step.finished`    | `index`                                                                                                            |
| Message | `message.started`                  | `messageId`, `role`, `continuing?`                                                                                 |
|         | `text.delta`                       | `messageId`, `contentIndex`, `text`, `tokens?`, `usage?`                                                           |
|         | `text.end`                         | `messageId`, `contentIndex`, full `text`                                                                           |
|         | `reasoning.delta`, `reasoning.end` | as for text                                                                                                        |
|         | `message.finished`                 | `messageId`, the complete `message`, `finishReason`, `usage?`                                                      |
| Tool    | `tool.called`                      | `messageId`, `contentIndex`, `callId`, `name`, `arguments`                                                         |
|         | `tool.malformed`                   | `callId`, `name`, `error`, and (in a loop) `contentIndex`, raw `arguments`                                         |
|         | `tool.approval_requested`          | `requestId`, `callId`, `name`, `arguments`, `alwaysAsks?`, `agentSetting?`, `review?`                              |
|         | `tool.approval_resolved`           | `requestId`, `choice`, `note?`                                                                                     |
|         | `input.requested`                  | `requestId`, `callId`, `form`                                                                                      |
|         | `input.resolved`                   | `requestId`, `outcome` (`answered` or `skipped`)                                                                   |
|         | `request.cancel`                   | `requestId`, `reason`. Withdraws an open approval or form.                                                         |
|         | `tool.update`                      | `callId`, `partial`. Progress text from a running tool.                                                            |
|         | `tool.result`                      | `messageId`, `callId`, `name`, `isError`, truncated `preview`, `durationMs`, `error?`                              |
|         | `user.message`                     | `messageId`, `source`, `content`. A message the user sent to a running subagent, added by the loop (stored first). |

Rules that make the stream reliable:

- `text.delta` and `reasoning.delta` carry the cumulative `usage` when known,
  so a client can show a live token count.
- `text.end` and `reasoning.end` carry the block's full text and replace
  whatever was built from deltas.
- `message.finished` carries the authoritative message and replaces anything
  built from deltas. `finishReason` is `stop`, `length`, `tool_calls`,
  `cancelled` or `error`.
- `tool.result.messageId` names the stored tool result message. It is stored
  before the event is sent, so a client can refetch and find it.
- `tool.result.preview` is cut to 500 characters; the full text is in the
  message.

### Session events

| Event                     | Data                                                             | Emitted when                                                        |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `session.trashed`         | (empty)                                                          | The session was moved to the trash.                                 |
| `session.entries_changed` | `messageId`                                                      | The user edited session files or notes (an edit message was added). |
| `session.data_changed`    | `messageId`                                                      | The user edited session schemas or data.                            |
| `session.renamed`         | `title`, `source` (`user`, `model`, `message`), `model`, `usage` | The title changed.                                                  |
| `session.agent_changed`   | `agentId` or `null`                                              | A tool changed the session's agent.                                 |

### Rebuilding a message from events

`message-state.ts` exports `applyMessageEvent(content, messageId, event)` and
`buildMessageContent(events, messageId, initial)`. Given the events of one
message, they reconstruct its content blocks. The backend uses this to recover
a half-written message after a crash and to describe an in-flight message in a
snapshot; the frontend uses it to render streaming text. Because it is pure and
shared, both sides agree on the result.

## The model interface

`model.ts` defines what any model backend must implement:

```ts
interface ModelAdapter {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}
```

A **chat request** has `messages`, optional `tools`, `model`,
`reasoningEffort`, `sampling` (temperature, topP, topK, minP, repeatPenalty,
seed, maxTokens) and an optional `control`. A **raw request** sends plain text
with no chat template.

A model yields **chunks**:

| Chunk       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `text`      | A piece of answer text (raw requests may add per-token data).             |
| `reasoning` | A piece of reasoning text.                                                |
| `tool_call` | One _complete_ call with `callId`, `name` and the raw `arguments` string. |
| `usage`     | Token usage so far, or final.                                             |
| `finish`    | `stop`, `length` or `tool_calls`.                                         |

### The llama-server adapter

`LlamaServerAdapter` (`llama-server/adapter.ts`) implements `ModelAdapter` for
llama.cpp's `llama-server`.

**Chat requests** go to `POST /v1/chat/completions` with `stream: true`,
`stream_options.include_usage` and `timings_per_token`. The server applies the
model's chat template. The adapter:

- converts messages to the OpenAI shape: an assistant message's text blocks are
  joined into `content`, its reasoning blocks into `reasoning_content`, its
  tool calls into `tool_calls` with JSON-stringified arguments; a tool result
  becomes a `tool` message with `tool_call_id`;
- sends a user message that has files as typed content parts: each
  image as `image_url` (a base64 data URI), each audio file as `input_audio`
  (base64 and a format), then the message's text as a `text` part. Media comes
  first, which is how Gemma expects audio. A message without files is
  still sent as a plain string. llama-server needs a multimodal projector
  (`--mmproj`) loaded for the model to accept these parts;
- sends tool definitions as `function` tools;
- sends `model` and `reasoning_effort` when set;
- emits `reasoning` chunks from `reasoning_content` and `text` chunks from
  `content`;
- assembles streamed tool-call fragments by index and emits each complete call
  after the stream ends (ordered by index; a missing id becomes `call_<index>`);
- emits `usage` while streaming (prompt = cached + evaluated prompt tokens,
  completion = predicted tokens, from the per-token timings) and the exact
  figures from the final usage chunk.

A conversation that ends with an assistant message is continued by the
server (assistant prefill).

**Raw requests** go to `POST /completion` and read the native stream, optionally
requesting per-token probabilities.

**Ending reasoning early.** When the request has a `RunControl`, the adapter
asks llama-server to arm reasoning control and binds
`control.endReasoning()` once the first chunk reveals the response id. Calling
it sends `POST /v1/chat/completions/control` with `action: "reasoning_end"`.
After the response ends the control reports that it is no longer available.

**Errors.** Non-2xx responses and stream errors raise `LlamaServerError`.
When the abort signal has fired, errors are swallowed: cancellation is not a
failure.

Other llama-server helpers in `llama-server/`:

| Module          | Function                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `models.ts`     | `listLlamaServerModels` (router `GET /models`, falling back to `/v1/models`; each model's `inputModalities` come from `architecture.input_modalities`), `mediaSupport` (whether a model reads images and audio, or `undefined` when the server did not say), `loadLlamaServerModel`. |
| `props.ts`      | `getReasoningLevels` and `getContextSize`, read from `GET /props`.                                                                                                                                                                                                                   |
| `embeddings.ts` | `embedTexts` via `POST /v1/embeddings`.                                                                                                                                                                                                                                              |
| `sse.ts`        | `readSseData`, an async iterator over `data:` lines.                                                                                                                                                                                                                                 |

### Test doubles

`ScriptedModel` (`fake-model.ts`) replays scripted responses, one per request,
including `throw` and `wait` steps, and records every request it receives.
`@harness/core/testing` exports a fake llama-server and fake shared entries.

## Running a model call: `streamMessage`

`run.ts` contains the function that turns one streamed model response into one
assistant message. `streamMessage(model, request, options)`:

1. Emits `message.started` (with `continuing: true` if it extends an existing
   message).
2. Reads chunks from the model. Text and reasoning chunks extend an _open
   block_; switching type closes the open block (emitting `text.end` or
   `reasoning.end`) and opens a new one.
3. For each `tool_call` chunk, closes the open block and parses the
   arguments. Valid JSON becomes a `tool_call` block and a `tool.called`
   event. Invalid JSON becomes a `tool.malformed` event; in a loop
   (`keepMalformed: true`) the call stays in the message with its raw argument
   string.
4. Tracks `usage` and the finish reason.
5. On failure sets finish reason `error`; if the signal aborted, `cancelled`.
6. Closes the open block, calls `beforeFinished` (the loop uses it to store the
   message), and emits `message.finished`.

It never throws for model errors. The failure text is returned to the caller.

`runSingleCall` wraps one `streamMessage` between `run.started` and
`run.finished`/`run.failed`. It reports tool calls but does not run them.
The backend uses the loop for all runs.

## The agent loop: `runLoop`

`loop.ts` implements the cycle _model → tools → model → …_.

```ts
runLoop(model, request, ctx): Promise<LoopResult>
```

`request.messages` is the starting transcript (including the system message).
The loop appends to its own copy as it goes, and sets `request.tools` from
`ctx.tools`. `ctx` extends `RunContext` (run id, session id, `emit`, abort
signal, optional agent info) with everything a run needs, described below. It
never throws for model or tool errors.

### One run, step by step

```
emit run.started
for index = 0, 1, 2, …
    if index ≥ maxIterations → end: iteration_limit
    emit step.started
    streamMessage(...)                       # one model call
    store the assistant message (if non-empty)
    if the model call failed → give each call a "Not run" result; end: failed
    if there are no tool calls:
         top-level run: end: stop
         subagent: send a reminder (up to N), or end with its last text
    else for each tool call, in order:
         runCall(call)                        # approval, execute, store result
    emit step.finished
    if a call failed the run → end: failed
    if a call handed back    → end: handed_back
    if the signal aborted    → end: cancelled
emit run.finished   (or run.failed)
```

Details worth knowing:

- **Calls run one at a time, in the order the model wrote them.** Once a call
  fails the run, a subagent hands back, or the run is cancelled, the remaining
  calls in that response get an error result saying they were not run.
- **A response cut off at the token limit** (`finishReason: length`) may
  contain truncated arguments, so none of its calls are run; each gets a
  "Not run" result.
- **Messages are stored as they complete.** `onMessage(messageId, message,
usage?)` is called with each assistant message just before its
  `message.finished` event, and with each tool result just before its
  `tool.result` event. This ordering is why a client that receives an event can
  rely on the message being stored.
- **Usage** is summed across all model calls and reported in `run.finished`.
- **Continuing.** With `ctx.continueMessage`, the first step extends an existing
  assistant message instead of starting a new one.

### Running one tool call: `runCall`

1. **Malformed arguments** → an error result (`malformed_call`).
2. **Unknown tool name** → an error result (`unknown_tool`).
3. **Argument validation** with the tool's Zod schema → on failure an error
   result with the validation message (`invalid_arguments`).
4. **Approval**, if `ctx.needsApproval(tool)` says so:
   - If the tool declares `review`, it is called first to work out the call's
     changes. If the call is refused as it stands, that refusal is the result
     and nothing is asked.
   - `tool.approval_requested` is emitted, then the loop waits on
     `ctx.approve(...)` for as long as it takes (it stops waiting if the run is
     cancelled, emitting `request.cancel`).
   - `tool.approval_resolved` is emitted. A note (kept only with _once_ or
     _deny_) is stored on the result. _Deny_ produces the error result "The user
     denied this tool call."
   - For a call with a review, the answer may include a `selection` of
     changes; the tool receives it as `ctx.approval`.
5. **Execute** `tool.execute(input, toolContext)`.
6. **Store the result.**
   - `data` is serialized for the model: a string as is, anything else as JSON.
   - Error text longer than 2,000 characters (`errorLimit`) is truncated for the
     model; the full text is kept in the `tool.result` event.
   - Session-scoped file, note, schema and data changes are recorded on the
     message **only if the tool succeeded**.
   - `state`, the approval `note` and the shown form are recorded too.
7. **Ending the run.** A result with `handback` ends a subagent's run. A thrown
   `ToolRunError` ends the run as failed. Any other thrown error becomes an
   error result `"<tool> failed: <message>"` and the run continues. If the
   signal aborted, the result is "Not run: the run was cancelled."

Errors worth showing in the errors console are passed to `ctx.reportError` after
their result is stored. Kinds: `tool_threw`, `tool_returned_error`,
`unknown_tool`, `invalid_arguments`, `malformed_call`. Denied calls, calls not
run, and forms the user skipped are not reported.

### Subagent behaviour in the loop

When `ctx.child` is set the loop runs as a subagent:

- A model response with no tool calls does not end the run. The loop adds a
  user message with `reminderText` and calls the model again, up to
  `child.reminders` times (each reminder uses an iteration).
- After the reminders are used up, the last text the subagent wrote becomes its
  output and the run ends with reason `stop`.
- If a tool result has `handback`, the run ends with `handed_back` and
  `LoopResult.output` holds that text.

### Messages from the user to a running run

`ctx.takeUserMessages` returns the messages the user sent to the run while it
ran, oldest first. The loop takes them:

- at the start of every step, before the model call, so a message sent during a
  step is read at the next one. The step that is running is not interrupted and
  its remaining tool calls still run;
- when a subagent would stop with no tool calls, or has handed back, and a
  message is waiting. The run then gets one more step to read it instead of a
  reminder (a hand back is dropped; the subagent can hand back again).

Each message is added as a user message with `source: "user"`, passed to
`onMessage` (so it is stored first), sent as a `user.message` event, and added to
the transcript. Without the hook, nothing is taken.

### The loop context

`LoopContext` is how the caller supplies everything else:

| Field                                                                  | Purpose                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tools`, `maxIterations`                                               | The tools offered and the iteration cap.                                                               |
| `needsApproval`, `agentDecides`, `approve`                             | Whether a tool asks, whether the agent's setting is the reason, and how to wait for the user's answer. |
| `requestInput`                                                         | How to show a form and wait for answers.                                                               |
| `onMessage`, `reportError`                                             | Persistence and error reporting hooks.                                                                 |
| `errorLimit`, `previewLimit`, `cancelledText`                          | Truncation limits and wording.                                                                         |
| `projectId`, `projectName`                                             | The session's project, if any.                                                                         |
| `sharedEntries`, `searchEntries`, `newNoteId`                          | Project and global files and notes; search; id generation.                                             |
| `sharedData`, `schemaChecker`                                          | Global, project and agent schemas and data; JSON Schema validation.                                    |
| `projects`, `agents`, `subagents`                                      | Access for the project, agent and subagent tools.                                                      |
| `skills`, `copyLimit`                                                  | The skills in scope; the maximum keys per copy or move call.                                           |
| `child`                                                                | Present for a subagent's run.                                                                          |
| `takeUserMessages`                                                     | Takes the messages the user sent to the run (see above).                                               |
| `sessionMessages`                                                      | A function returning **all** of the session's messages, used to rebuild session-scoped state.          |
| `parentRunId`, `parentCallId`, `agent`, `continueMessage`, `messageId` | Run identity and continuation.                                                                         |

Where an optional capability is omitted, the matching tool fails with "… are
not available in this run" instead of crashing.

## Tools (API)

`tools.ts` defines how a tool is declared and what it can reach. See
[tools.md](tools.md) for the concrete tools.

```ts
const tool = defineTool({
  name: "current_date",              // 1–64 chars: letters, digits, _ and -
  description: "…",
  input: z.object({ … }),            // must be an object schema
  approval: "never",                 // "ask" | "never" | "always"
  group: "utilities",                // one of TOOL_GROUPS
  alwaysOn: false,                   // optional, default false
  needsReview: false,                // optional, default false
  available: (run) => true,          // optional; run is a RunFacts
  execute: (input, ctx) => ({ data: … }),
  review: (input, ctx) => …,         // optional
});
```

`TOOL_GROUPS` lists the groups a tool can belong to, in display order (`files`,
`memory`, `structured-data`, `projects`, `agents`, `subagents`, `sessions`,
`skills`, `web`, `utilities`). `RunFacts` describes the run a tool would be
offered in: `hasSkills`, `isChild` and `canStartSubagent`. What these fields mean
for the tools a run gets is described in [tools.md](tools.md#tool-groups).

`defineTool` converts the Zod schema to JSON Schema for the model and **rejects
integer fields that lack both a minimum and a maximum**, so every number the
model can send is bounded.

A tool returns a `ToolOutput`:

| Field      | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `data`     | The structured result. Serialized for the model.                                         |
| `isError`  | Marks the result as an error. The run continues.                                         |
| `details`  | Extra information for the errors console. Never sent to the model.                       |
| `state`    | Replaces the tool's saved state. Left out: unchanged.                                    |
| `handback` | Ends a subagent's run with this output. Calls after it in the same response are not run. |

Two exception classes control failure: `ToolError(message, { details, cause })`
becomes an error result; `ToolRunError` (a subclass) ends the whole run as
failed.

### `ToolContext`

What a tool's `execute` receives:

| Field                                    | Description                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `signal`, `sessionId`, `runId`, `callId` | Identity and cancellation.                                                       |
| `update(partial)`                        | Emits a `tool.update` event.                                                     |
| `state`                                  | The latest state this tool saved in the transcript.                              |
| `projectId`, `projectName`               | The session's project.                                                           |
| `entries`                                | `EntryAccess`: files and notes across scopes.                                    |
| `data`                                   | `DataAccess`: schemas and data across scopes.                                    |
| `projects`                               | `ProjectAccess`: list, current, create, push.                                    |
| `agents`                                 | `AgentAccess`: list agents, current agent.                                       |
| `subagents`                              | `SubagentAccess`: depth, `canStart`, `start(...)`.                               |
| `skills`                                 | The skills in scope with their bodies.                                           |
| `workspaces`                             | `WorkspaceAccess`: list, `locate`, read, write, edit, move, delete and folders.  |
| `copyLimit`                              | Maximum keys per copy or move call.                                              |
| `mediaSupport`, `blobs`                  | What the model reads; stores bytes as blobs (for tools that make binary files).  |
| `requestInput(form)`                     | Show a form and wait. At most **one** per call.                                  |
| `approval`                               | For a tool with `review`: the review the user answered and the chosen selection. |

`Tool.approvalSubject(input, ctx)` lets a tool name what a call is about
(`{ kind: "workspace", id, label }`). The loop asks it before `needsApproval`, puts
the subject in `tool.approval_requested` and in the `ApprovalRequest`, and passes
it to `needsApproval(tool, subject)`. A tool without one behaves as before.
`WorkspaceAccess` and `WorkspaceError` are in `workspaces.ts`; the error's `code`
(`outside`, `stale`, `read_only`, …) becomes the tool's error result.

Tools never reach the database directly. They use these interfaces, and the
backend decides what is behind them.

## Files and memory notes (`entries.ts`)

Files and memory notes (together _entries_) exist in three scopes.

- **session**: stored only in the transcript. `replaySessionEntries(messages)`
  starts empty and applies every `EntryOp` (`put` or `delete`, with kind, key,
  value, and file type) found on tool results and edit messages, in order.
  It also remembers every key ever used so that note ids are never reused.
- **project** and **global**: stored by the backend. Core sees them through
  the `SharedEntries` interface (`list`, `get`, `exists`, `put`, `delete`).

`createEntryAccess(...)` builds the `EntryAccess` a tool gets for one call. It
combines the replayed session state with the shared scopes, only offers the
`project` scope when the session is in a project, and appends every
session-scoped change to a list that the loop records on the call's result.
`checkFileKey` and `checkFileValue` enforce the key pattern
(`^[A-Za-z0-9._-]+$`) and that `json` files parse.

Search is a function supplied by the caller (`EntrySearch`); without it,
search tools fail with "Search is not available."

`chunking.ts` splits file text for search: pieces of at most 1,500 characters,
split at Markdown headings first, then blank lines, then sentence ends, and
inside a sentence only as a last resort; small neighbours are packed together.

## Schemas and data (`schemas-data.ts`)

A **schema** is a named JSON Schema with versions; **data** is a JSON value
made from one schema version. They follow the same pattern as entries.

- Four scopes: `global`, `project`, `agent`, `session`; schemas also have a
  read-only `builtin` scope.
- **session** schemas and data are replayed from `DataOp`s on tool results and
  edit messages (`schema_put`, `schema_delete`, `data_put`, `data_delete`). A
  `schema_put` carries the schema's whole current state, and a `data_put` the
  piece's whole value.
- The other scopes are reached through `SharedData`.
- `createDataAccess(...)` builds the `DataAccess` tools use. It enforces name
  and description limits (64 and 1,024 characters), scope rules, version
  pinning and migrations, and produces _plans_ (`planCreate`, `planUpdate`, …)
  that describe a change before it is committed. Tools turn plans into reviews.
- Validation uses a `SchemaChecker` interface. The Ajv implementation lives in
  the backend because Ajv compiles schemas to functions and runs only there.
- `applyMergePatch` implements RFC 7396; `applyDefaults` fills schema defaults.
- `schema-features.ts` defines the JSON Schema subset schemas may use (the
  features the forms and schema builder can draw). `checkSchemaFeatures`
  rejects unknown keywords, so a typo like `requird` is an error instead of a
  silently ignored rule.

`review.ts` and `changes.ts` support approval with review: `changesBetween`
computes the field-level changes between two JSON values (paths are RFC 6901
JSON Pointers), `Review` and `ReviewItem` describe them, `Selection` records
which changes the user approved, and `applySelection` builds the value the user
approved.

## Input forms (`forms.ts`)

A form is how a tool asks the user questions.

- `ask_user` takes a JSON Schema object; `readForm` reads it _leniently_ into a
  `Form` (a list of fields with kinds such as text, one choice, several
  choices, number, yes/no, nested objects and lists) and reports problems so
  the model can retry.
- Every question except free text also offers an "Other" answer (free text in
  place of the value). Tools that build their own forms can label options, omit
  "Other" and name the buttons.
- `checkAnswers(form, answers)` validates and normalizes the user's answers.
- `describePrompt(form, answer)` produces the `PromptRecord` stored on the tool
  result.
- `readSchemaForm`, `schemaFormValue` and `schemaFormAnswers` convert between
  a data schema and a form, so the UI can edit data with forms generated from
  its schema.

A skipped form produces the result `"The user declined to answer."` flagged as
an error, which the loop does not report to the errors console.

## Cancellation and run control

Cancellation is an `AbortSignal` passed everywhere: into the model stream, into
`ctx.approve` and `ctx.requestInput` (which stop waiting), and into each tool.
When it fires, in-flight calls finish with "Not run: the run was cancelled.",
open requests are withdrawn with `request.cancel`, and the run ends with
reason `cancelled`.

`RunControl` is the one mid-stream action available besides cancellation:
`endReasoning()` asks the model to stop thinking and answer.
