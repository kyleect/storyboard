# Frontend (`@harness/frontend`)

The frontend is a single-page React application built with Vite. It is a thin
client: it holds no durable state of its own and never talks to llama-server.
Everything it shows comes from the backend's HTTP API and event streams.

**Stack:** React 19, [Mantine](https://mantine.dev) 9 (components, forms, modals,
notifications), [TanStack Router](https://tanstack.com/router) (routing),
[TanStack Query](https://tanstack.com/query) (server state),
[Zustand](https://zustand.docs.pmnd.rs) (client state), `react-markdown` with
`remark-gfm` (Markdown), and CodeMirror (JSON editor).

```
packages/frontend/src
  main.tsx               providers, router, route table
  api.ts                 token handling, typed API client, stream URLs
  queries/               query-key factories, one file per feature
  live.ts                live run state (Zustand) and the two event-stream hooks
  picked.ts              the project picked in the navbar
  linear.ts, debug.ts    debug export → linear view; clipboard helpers
  schema-builder.ts      JSON Schema ⇄ editable field tree
  tool-grant.ts          tool grants: allowed tools and the edits a click makes
  routes/
    Layout.tsx           navbar, project picker, session list
    Chat.tsx             a session: transcript, composer, tabs
    ApprovalDialog.tsx   tool approval prompt
    AskUserForm.tsx      inline forms
    Entries.tsx          files and memory notes
    Agents.tsx, Skills.tsx, Schemas.tsx, Data.tsx   management pages
    Errors.tsx           errors console
    Settings.tsx         settings
    ToolSettings.tsx     the Settings tools section
    ToolGrantEditor.tsx  the agent editor's tools section
    ApprovalSelect.tsx   ask / don't ask choice
    ProjectPage.tsx      one project
    DebugPanel.tsx, LinearView.tsx   debugging tab
    ContextMeter.tsx, ModelPicker.tsx, ReasoningPicker.tsx, Markdown.tsx, …
```

## Development setup

`vite.config.ts` serves the app on port 5173 and **proxies `/api` to the
backend** (`http://127.0.0.1:4317`, or `HARNESS_BACKEND_URL`). The proxy also
closes the browser's side of a connection when the backend stops mid-response,
so an open event stream does not hang silently across a backend restart.

`@harness/core` is aliased to its **source** (`../core/src/index.ts`), so the
frontend uses core's types and pure functions without a build step.

## Authentication

`api.ts` reads the token once:

1. If the address has `#token=<hex>`, the token is saved to `sessionStorage` and
   the fragment is removed from the address bar.
2. Otherwise it is read from `sessionStorage`.

If there is no token the app shows only a notice telling the user to open the
link the backend printed. If a link with a new token is opened in an
already-open tab, the page reloads to use it.

Requests send `Authorization: Bearer <token>`. EventSource cannot set headers,
so the stream URLs add `?token=`. A 401 produces an error that tells the user to
reopen the backend's link.

## Routes

Defined in `main.tsx`; every page renders inside `Layout`.

| Path                                                        | Page                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `/`                                                         | Home                                                          |
| `/sessions/$sessionId`                                      | Chat                                                          |
| `/projects/$projectId`                                      | Project page (name, description, its sessions)                |
| `/projects/$projectId/files`, `/agents`, `/skills`, `/data` | A project's files and notes, agents, skills, schemas and data |
| `/files`, `/agents`, `/skills`, `/data`                     | The same for the global scope                                 |
| `/errors`                                                   | Errors console across all sessions                            |
| `/settings`                                                 | Settings                                                      |

## Where state lives

| Kind of state             | Held in                                      | Examples                                                                                                                                                     |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server state (fetched)    | TanStack Query cache                         | `["session", id]`, `["sessions", projectId]`, `["projects"]`, `["agents", …]`, `["skills", …]`, `["data", …]`, `["errors", …]`, `["models"]`, `["settings"]` |
| In-flight runs (streamed) | Zustand store `useLive`                      | The message being written, open approvals and forms, live token count, subagent runs                                                                         |
| Connection status         | `useLive.connected[sessionId]`               |                                                                                                                                                              |
| Picked project            | Zustand `usePicked`, saved in `localStorage` | Which project the navbar shows                                                                                                                               |
| Local UI state            | React `useState`                             | The draft message, the active tab                                                                                                                            |

The central idea: **the cache holds what is stored; `useLive` holds what is
happening right now.** When something finishes, the cache is updated (or
invalidated and refetched) and the live entry is cleared.

Query keys come from the factories in `queries/` (`sessionKeys`, `agentKeys`,
`entryKeys`, and so on), one per feature, following
[Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys).
Never write a key inline. Keys go from the most generic to the most specific,
for example `["sessions", "list", { projectId }]` and
`["sessions", "detail", id]`, so a mutation or a stream event can invalidate
exactly what it changed: `sessionKeys.lists()` for every session list,
`sessionKeys.detail(id)` for one session. `queries/keys.test.ts` pins down how
far each prefix reaches.

## Live updates

Two hooks in `live.ts` keep the UI current. Both use `EventSource` and reconnect
with exponential backoff (500 ms, doubling, capped at 5 s) when the browser
gives up on a closed stream.

### `useSessionEvents(sessionId, detail)`: one session's stream

Started by the Chat page after the session detail has loaded **from the
server** (not from a stale cache, so the snapshot's last event id is current).

1. **Seed from the snapshot.** `GET /api/sessions/:id` returned `activeRun` and
   `childRuns`. These become the `useLive` entry: the run, its in-flight message,
   open approvals and forms, and its subagent runs.
2. **Open the stream** at `lastEventId` from the snapshot.
3. **Apply each event.** The handler is a switch on `event.type`:

| Event                                                                                         | Effect                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.started`                                                                                 | Create the live run. A run with `parentRunId` and `parentCallId` is added as a **child** of the top-level run instead of replacing it.                                                                                                  |
| `message.started`                                                                             | Set the run's in-flight message (starting from the stored content if it continues a message).                                                                                                                                           |
| `text.delta`, `reasoning.delta`, `text.end`, `reasoning.end`, `tool.called`, `tool.malformed` | Apply to the in-flight message with core's `applyMessageEvent`. Update the live token count from `usage`. The first delta of a run also refreshes model information (a model is loaded by its first request).                           |
| `message.finished`                                                                            | Write the stored message into the session cache and clear the in-flight message.                                                                                                                                                        |
| `tool.result`                                                                                 | Invalidate the session (the result message is already stored). Also invalidate the data queries for `schema*`/`data*` tools, the session's file and note lists for `files_*`/`memory_*` tools, and the session's errors on failure.     |
| `tool.approval_requested`, `input.requested`                                                  | Append to the run's open approvals or forms.                                                                                                                                                                                            |
| `user.message`                                                                                | The run read the oldest message the user had sent it: drop it from the run's waiting messages and refetch the session (the message is already stored).                                                                                  |
| `tool.approval_resolved`, `input.resolved`, `request.cancel`                                  | Remove the matching open request.                                                                                                                                                                                                       |
| `run.finished`, `run.failed`, `run.interrupted`                                               | A child run: show a notification if it still had unread messages from the user, refetch, then remove the child. A top-level run: refetch the session and session lists, then clear the live entry. A failure also shows a notification. |
| `session.renamed`                                                                             | Update the title in the cache and refetch lists.                                                                                                                                                                                        |
| `session.entries_changed`, `session.data_changed`, `session.agent_changed`                    | Invalidate the session and the relevant lists.                                                                                                                                                                                          |
| `session.trashed`                                                                             | Invalidate lists and navigate home.                                                                                                                                                                                                     |

Because `useLive.update` addresses a run by id, events from a **subagent** run
update that child's state without touching the parent's.

### `useAppEvents()`: the app-wide stream

Mounted once in `Layout`. It subscribes to `/api/events` and invalidates the
matching query families on `agents.changed`, `skills.changed`, `data.changed`,
`projects.changed` and `errors.changed`. Since these events are not replayed, it
also refetches agents, skills, errors, projects and data **every time the stream
opens**. This is how a change made in one window, or by a tool, appears in every
other window.

## The Chat page

`routes/Chat.tsx` is the main screen. It has five tabs:

| Tab    | Content                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| Chat   | The transcript, the composer, and the live run.                               |
| Files  | The session's own files. Project and global files are managed on their pages. |
| Memory | The session's memory notes.                                                   |
| Data   | The session's schemas and data.                                               |
| Debug  | The linear view, an event table, and each run's request.                      |

**Loading.** `["session", id]` fetches the session detail: session, project, all
messages (with model, effort, agent version, usage, run id, parent call id),
subagent usage, and the live-run snapshot.

**The transcript** is the stored messages with live messages merged in: an
in-flight message replaces its stored version (if continuing) or follows the
stored messages. A subagent's messages are grouped under the tool call that
started it, in a collapsible `SubagentPanel` that also shows that child's live
state and approvals. `TranscriptScroll` keeps the view pinned to the bottom while
new text arrives unless the user has scrolled away.

**Message rendering.** `MessageView` renders each role: user text, assistant
blocks (Markdown text, collapsible reasoning, tool calls), tool results
(including saved approval notes and the form the tool showed), and edit notices.
`Markdown.tsx` renders Markdown safely: raw HTML is shown as text, images are
never loaded (shown as their alt text), and links open in a new tab and only for
`http`, `https` and `mailto`.

**Composer actions.** Send, Continue, Cancel and "Stop thinking" call the
corresponding endpoints. Sending includes the session's current model, effort and
agent choices, which the backend saves.

**Pickers.** `ModelPicker` lists the models llama-server offers with their load
status and asks the router to load one; `ReasoningPicker` shows the effort levels
the selected model's template supports; the agent picker lists the agents the
session may use. `ContextMeter` shows how full the context is: the latest model
call's prompt plus completion tokens against the model's context size.

### Answering the model

Two kinds of prompts come from a running tool call. Both stay open until
answered, and both are re-created after a page reload from the snapshot.

- **Approval** (`ApprovalDialog`). Shows the tool name and arguments. Offers
  _Allow once_, _Allow for this session_, _Always allow this tool_, and _Deny_;
  an optional note can be typed with _once_ or _deny_. An always-asks tool offers
  only _once_ and _deny_. If the call has a **review**, the dialog lists each item
  with its field-level changes as checkboxes; the chosen subset is sent as the
  `selection`. It can validate the selection (`…/check`) and refresh a stale review
  (`…/refresh`). Closing the dialog does not answer it: the run keeps waiting.
- **Forms** (`AskUserForm`). Drawn inline in the transcript where the call is.
  Fields are generated from the form (text, one choice, several choices, number,
  yes/no, nested groups and lists), each with an "Other" answer unless the tool
  omitted it. Answered or skipped forms are shown read-only afterwards.

Both are sent with the id of the **run that asked**, so a subagent's question is
answered against the child run.

## Management pages

Each follows the same layout: a list on the left, the selected item on the right,
one page per scope.

| Page                        | Edits                  | Notes                                                                                                                                                                                                                           |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Entries.tsx`               | Files and memory notes | Files in a list with a viewer/editor; notes as cards. Version history opens in a dialog, where an older version can be made current.                                                                                            |
| `Agents.tsx`                | Agents                 | Prompt, tool grant (see below), per-tool approval, subagent settings, import and export, version history, and a read-only view of the agent version a message was written with.                                                 |
| `Skills.tsx`                | Skills                 | Display name, description, body.                                                                                                                                                                                                |
| `Schemas.tsx`               | Schemas                | A **builder** (a field tree and the selected field's settings) or a JSON editor (CodeMirror); earlier versions can be viewed. The builder only offers features the schema subset supports, so what it produces is always valid. |
| `Data.tsx`, `DataValue.tsx` | Data                   | Forms generated from the schema; the backend's validation is final and its problems are shown next to the fields. `DataValue` renders data read-only, laid out by its schema.                                                   |
| `Errors.tsx`                | (read)                 | Every recorded tool error and failed run, with a link to the message in the transcript. Also shown as a panel under each chat.                                                                                                  |
| `Settings.tsx`              | Settings               | All settings, global system prompt, title settings, and the tools section (see below). Shows which settings an environment variable overrides.                                                                                  |

**The agent's tools.** `ToolGrantEditor` shows tools under their group. Each group
has its own on/off box and approval choice (each tool's setting, ask for all, or
don't ask for all). Tools that are always on are shown locked, tools added since
the agent was last saved (`newTools`) are marked, and a switch changes the agent
between `allow` and `deny` mode. `tool-grant.ts` holds the pure logic: it works
out which tools a grant allows with the same rules as the backend and computes
the grant that results from a click on a group or a tool.

**Settings tools.** `ToolSettings` lists every tool under its group with three
settings: always on, asks before it runs, and off for the whole harness. A group's
header sets all three for the group. Changes are saved as they are made. A tool
that always asks keeps its approval fixed, and the page names the agents that
allow a tool before it is switched off.

In the session context, edits to session-scoped files, notes and data go through
`…/sessions/:id/…` routes and become **edit messages** in the transcript. They
are disabled while a run is active.

## Debugging views

`GET /api/sessions/:id/debug` returns the export described in
[backend.md](backend.md#debug-export). The Debug tab shows it three ways:

- **Linear view** (`linear.ts`, `LinearView.tsx`): one chronological list. Each
  run opens with the system prompt and tool list it was given, then messages and
  important events (approvals, forms, run endings) in order. Events that only
  repeat message content (deltas, block ends, `tool.called`) are omitted.
  Subagent runs are indented by depth.
- **Event table**: every event, filterable by type.
- **Run requests**: each run's exact system message and tools.

The export can be copied to the clipboard as the linear text or as JSON.

## Testing

Tests run with Vitest and `jsdom` with Testing Library (`test-setup.ts`). They
cover the stream reducer (`live.test.tsx`), the linear view, the schema builder,
and the major components (approval dialog, forms, data, schemas, errors, Markdown).
