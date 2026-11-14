# Frontend (`@harness/frontend`)

The frontend is a single-page React application built with Vite. It is a thin
client: it holds no durable state of its own and never talks to llama-server.
Everything it shows comes from the backend's HTTP API and event streams.

**Stack:** React 19, [Mantine](https://mantine.dev) 9 (components, forms, modals,
notifications), [TanStack Router](https://tanstack.com/router) (routing),
[TanStack Query](https://tanstack.com/query) (server state),
[Zustand](https://zustand.docs.pmnd.rs) (client state), `react-markdown` with
`remark-gfm` (Markdown), [Tabler icons](https://tabler.io/icons), and CodeMirror
(the JSON editor and the Files editor).

```
packages/frontend/src
  main.tsx               providers, router, route table
  api.ts                 token handling, typed API client, stream URLs
  queries/               query-key factories, one file per feature
  stores/                client state (Zustand): live runs, tabs, drafts, dirty tabs, chat status, appearance, profile, sessions table choices, agent focus
  hooks/                 high-level hooks: data, live updates, actions (see Hooks)
  lib/                   plain logic with no React state: event-stream, favicon, notify, workbench tabs, explorers, schema builder, tool grants
  components/            shared components, reusable across routes
    explorer/            the file explorer: shell, tree, tabs, editor, the Files view
    structured/          the Structured Data view, schema builder and data forms
  routes/<route>/        one folder per route
    <Route>.tsx          the route component: what renders for the route's address
    components/          components only this route uses
    lib/                 logic only this route uses
```

### Three kinds of component

- **Route components** (`routes/<route>/<Route>.tsx`) render for an address: the
  page a workbench tab shows. They wire hooks to components and own no layout
  that another page could reuse.
- **Route-specific components** (`routes/<route>/components/`) belong to one
  route and are imported only by it, or by its tests.
- **Shared components** (`components/`) are reused by more than one route. A
  component starts in its route's `components/` and moves here when a second
  route needs it.

Shared layers (`components/`, `hooks/`, `stores/`, `lib/`) never import from
`routes/`, and a route does not import another route's `components/` or `lib/`. ESLint
enforces both (`no-restricted-imports` in `eslint.config.js`).
The route components of other routes may be imported where a page embeds
another (the project page shows `Sessions`, for example). Tests may cross these
boundaries.

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

Defined in `main.tsx`. The routes are the addresses of the workbench's tabs (see
[The workbench](#the-workbench)): `Layout` draws the workbench, and the routes
render nothing themselves.

| Path                                                        | Page                                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/`                                                         | No tab: the saved active tab is shown, else an empty state                        |
| `/sessions`                                                 | Chats with no project: a table                                                    |
| `/sessions/$sessionId`                                      | Chat                                                                              |
| `/projects/$projectId`                                      | Project page (name, color, description, links to its pages, its chats as a table) |
| `/projects/$projectId/files`, `/agents`, `/skills`, `/data` | A project's files, agents, skills, schemas and data                               |
| `/files`, `/agents`, `/skills`, `/data`                     | The same for the global scope                                                     |
| `/workspaces`                                               | Workspaces: folders, writable or read-only, trash, grants                         |
| `/errors`                                                   | Errors console across all sessions                                                |
| `/settings/$` (`/settings` redirects to `general/models`)   | Settings; the splat is `<area>/<section>`                                         |

### Shared building blocks

- `ExplorerPanel` is the sized box every explorer page sits in; it reports
  unsaved edits to the workbench.
- `ProjectGate` loads a project for a project-scoped page and shows the loading
  and error states; `trashedNote` and `ProjectScopeNote` give the read-only
  reason and the intro line.
- `VersionsModal` is the version history dialog of files, data and agents; each
  caller gives it the labels, the body and how to restore.
- `confirmAction` (`lib/confirm.tsx`) opens a confirmation with a title, a
  message and a button label; add `danger: true` for a red button.

## Hooks

Components do not write `useQuery`, `useMutation` or stream code themselves.
They call a high-level hook from `hooks/` that returns what the UI needs, the
way `useUnreadSessions` returns the unread counts. A hook owns its query key
(from `queries/`), the `select` that shapes the data, and the invalidation that
follows a change. Components never see a key.

**Data**

| Hook                                            | Returns                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `useProjects()`, `useProject(id)`               | The project list (most recently used first); one project.                              |
| `useSaveProject(id)`                            | A function that saves project fields, updates the cache and refetches the list.        |
| `useSetDefaultAgent(projectId?)`                | A mutation that sets a project's default agent, or the app's when there is no project. |
| `useSession(id)`, `useCreateSession(onCreated)` | One session's detail; a mutation that creates a session in a project or none.          |
| `useSettings()`                                 | The settings and which are set by an environment variable.                             |
| `useModels()`                                   | The models, polled while one is loading.                                               |
| `useUnreadSessions()`                           | `{ sessions, ids, count }`: the sessions with a reply the user has not seen.           |
| `useActiveRuns()`                               | The runs in progress, summed up per session (working, waiting).                        |
| `useProjectColor()`                             | A function from a project id to its color.                                             |
| `useStructured(...)`                            | The Structured Data view's lists, tree, tabs and actions.                              |

**Live updates**

| Hook                                  | Does                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `useSessionEvents(sessionId, detail)` | Seeds `useLive` from the session snapshot and applies one session's events (see Live updates).          |
| `useAppEvents()`                      | Mounted once in `Layout`; invalidates query families on app events and refetches when the stream opens. |

**Actions and effects**

| Hook                                         | Does                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `useSessionActions()`, `useProjectActions()` | Rename, trash, restore and delete, each with its confirmation, notification and refetching. |
| `useFaviconIndicator()`                      | Draws the tab icon and its dot from `useActiveRuns` and `useUnreadSessions`.                |
| `useDebouncedFlag(active, delays)`           | Follows a flag with a delay so an indicator does not flicker.                               |

**Writing one.** Put the query in `useX`, with the key from `queries/` and, if
the component needs a different shape, a `select`. Put a mutation's
invalidation in the hook's `onSuccess` and its failure message in `onError`
(`showError("Could not …")` from `lib/notify.ts`). Keep a pure part, such as
`summarizeRuns`, next to the hook and test it without React. Test the hook by
rendering a small component that calls it, as `hooks/useUnreadSessions.test.tsx`
does.

## Where state lives

| Kind of state             | Held in                                         | Examples                                                                                                                                                     |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server state (fetched)    | TanStack Query cache                            | `["session", id]`, `["sessions", projectId]`, `["projects"]`, `["agents", …]`, `["skills", …]`, `["data", …]`, `["errors", …]`, `["models"]`, `["settings"]` |
| In-flight runs (streamed) | Zustand store `useLive`                         | The message being written, open approvals and forms, live token count, subagent runs                                                                         |
| Connection status         | `useLive.connected[sessionId]`                  |                                                                                                                                                              |
| Workbench tabs            | Zustand `useWorkbench`, saved in `localStorage` | The open tabs, the folders open in the chats tree, the sidebar width                                                                                         |
| Message being written     | Zustand `useDrafts`                             | Each session's text and attachments, kept while its tab is not shown                                                                                         |
| Local UI state            | React `useState`                                | The active view of a chat, an edit in progress                                                                                                               |

The central idea: **the cache holds what is stored; `useLive` holds what is
happening right now.** When something finishes, the cache is updated (or
invalidated and refetched) and the live file is cleared.

Query keys come from the factories in `queries/` (`sessionKeys`, `agentKeys`,
`fileKeys`, and so on), one per feature, following
[Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys).
Never write a key inline. Keys go from the most generic to the most specific,
for example `["sessions", "list", { projectId }]` and
`["sessions", "detail", id]`, so a mutation or a stream event can invalidate
exactly what it changed: `sessionKeys.lists()` for every session list,
`sessionKeys.detail(id)` for one session. `queries/keys.test.ts` pins down how
far each prefix reaches.

## The workbench

The whole app is one workbench (`routes/workbench/components/Workbench.tsx`, drawn by `Layout`): a 52px
icon rail (`Rail.tsx`), a resizable chats tree (`ChatsTree.tsx`), a strip of tabs
with the active tab's page below it, and a status bar. It uses the frame the Files
and Structured Data views share (`ExplorerShell.tsx`) and the tab rules in
`lib/explorer.ts`. `lib/workbench.ts` is the pure part: the kinds of tab, `tabForPath` and
`pathForTab` (an address and its tab), `newChatTarget`, and `closeTarget`.

- **The address decides the active tab.** Clicking a tab navigates; an address that
  is opened (a link, the address bar, Back, or the saved tab at `/`) opens or
  activates its tab. A tab opened by a single click in the tree, or from the rail, is
  in italics and is replaced by the next one; a double click on it or on the row, the
  new-chat button and an address keep it. `/settings` is one tab, and returns to the section last
  used.
- **What a tab says.** A chat is its title with a chat icon; a project is its name
  with a blue folder icon; a page of a project is the project's name, then the page
  (`Novel › Files`), with a blue icon; a global page is its name. The hover
  text spells the kind out ("Project: …", "Chat: …", "Files (all
  projects)").
- **Reordering.** Tabs are dragged to a new place, or moved with Alt and the left or
  right arrow (`moveTab` in `lib/explorer.ts`); the order is saved with the tabs.
- **Which tabs are mounted.** The active tab, and any tab with unsaved edits, which
  stays mounted but hidden. The rest are unmounted, so only the active chat holds an
  event stream (the browser allows about six HTTP/1.1 connections to a host). A chat
  in another tab still shows a spinner or the waiting badge, from the app-wide
  stream, but its transcript is not updated until it is shown again.
- **Drafts.** The text and attachments of the message being written are in
  `useDrafts`, so they survive the chat being unmounted. They are dropped, and the
  previews released, when the chat's tab is closed or the session is trashed.
- **Unsaved edits.** A page reports them with `useReportDirty` (the Chat page, for
  its Files and Structured Data views; the global and project Files and Structured
  Data pages). Closing such a tab asks first, and the browser asks before the page is
  reloaded while any tab has them. There is no router blocker.
- **New chat** goes to the project of the row last used in the tree, else the
  project of the active tab, else it is a standalone chat.
- **Trash.** Moving a session or a project to the trash closes its tabs
  (`closeTabsAndGo`), and a tab whose chat is gone closes itself.
- **The tree** lists each project, most recently used first, and "No project". A
  project opens to its latest chats (`TREE_CHATS`, five), then "Show all N chats",
  which opens the project's page, where all its chats are in a table. A project's
  files, agents, skills and Structured Data are links on its page and in the menu on
  its row. The "No project" row opens the table of the chats that have no project. A
  project's chats are read only while it is open. The filter matches project names
  and the chats already loaded, all of them. Which projects are open is saved with
  the tabs. A project's row in the tree is tinted in the project's color, and the
  icons of its chats are drawn in it. The chat that is open is highlighted in a
  darker shade of the same tint: more opaque on a light page, more transparent
  on a dark one (`selectedChatBackground` in `ChatsTree.tsx`). Every tab of the project (its page, its
  pages and its chats) has the color behind its icon and over it while it is
  open. The same goes for the tabs inside the Files, Skills, Agents and
  Structured Data pages that hold a project's own things (not the global or
  built-in ones), and the root name in a file's path is drawn in it
  (`useProjectColor`, which reads the project list the tree keeps loaded). A project without a color
  looks plain. The color is a Mantine theme color, so it follows light and dark
  (`projectColorVar` in `project-color.ts`), and is picked from the palette in
  `PROJECT_COLORS` (core) on the project's page or in the New project dialog.
  The rail's Chats button shows and hides the tree (kept in
  `harness.workbench.sidebar`); on a small screen it opens the drawer.
- **Small screens.** Below Mantine's `sm` breakpoint the rail and the tree are in a
  drawer, opened by a menu button at the left of the tab strip; the divider and the
  status bar are hidden, and the strip scrolls sideways.
- **Status bar.** The project and title of the active tab; for a chat, its model,
  the context ring and the connection, which `Chat` publishes to `useChatStatus`.

## Live updates

Two hooks, `hooks/useSessionEvents.ts` and `hooks/useAppEvents.ts`, keep the UI
current. Both open their stream with `connectEventStream` (`lib/event-stream.ts`),
which reconnects with exponential backoff (500 ms, doubling, capped at 5 s)
when the browser gives up on a closed stream. The live run state they write is
the `useLive` store in `stores/live.ts`.

### `useSessionEvents(sessionId, detail)`: one session's stream

Started by the Chat page after the session detail has loaded **from the
server** (not from a stale cache, so the snapshot's last event id is current).

1. **Seed from the snapshot.** `GET /api/sessions/:id` returned `activeRun` and
   `childRuns`. These become the `useLive` file: the run, its in-flight message,
   open approvals and forms, and its subagent runs.
2. **Open the stream** at `lastEventId` from the snapshot.
3. **Apply each event.** The handler is a switch on `event.type`:

| Event                                                                                         | Effect                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.started`                                                                                 | Create the live run. A run with `parentRunId` and `parentCallId` is added as a **child** of the top-level run instead of replacing it.                                                                                                 |
| `message.started`                                                                             | Set the run's in-flight message (starting from the stored content if it continues a message).                                                                                                                                          |
| `text.delta`, `reasoning.delta`, `text.end`, `reasoning.end`, `tool.called`, `tool.malformed` | Apply to the in-flight message with core's `applyMessageEvent`. Update the live token count from `usage`. The first delta of a run also refreshes model information (a model is loaded by its first request).                          |
| `message.finished`                                                                            | Write the stored message into the session cache and clear the in-flight message.                                                                                                                                                       |
| `tool.result`                                                                                 | Invalidate the session (the result message is already stored). Also invalidate the data queries for `schema*`/`data*` tools, the session's file lists for `files_*` tools, and the session's errors on failure.                        |
| `tool.approval_requested`, `input.requested`                                                  | Append to the run's open approvals or forms.                                                                                                                                                                                           |
| `user.message`                                                                                | The run read the oldest message the user had sent it: drop it from the run's waiting messages and refetch the session (the message is already stored).                                                                                 |
| `tool.approval_resolved`, `input.resolved`, `request.cancel`                                  | Remove the matching open request.                                                                                                                                                                                                      |
| `run.finished`, `run.failed`, `run.interrupted`                                               | A child run: show a notification if it still had unread messages from the user, refetch, then remove the child. A top-level run: refetch the session and session lists, then clear the live file. A failure also shows a notification. |
| `session.renamed`                                                                             | Update the title in the cache and refetch lists.                                                                                                                                                                                       |
| `session.files_changed`, `session.data_changed`, `session.agent_changed`                      | Invalidate the session and the relevant lists.                                                                                                                                                                                         |
| `session.transcript_changed`                                                                  | Invalidate the session, its files and data, and the lists (and the trash unless the reason is `edit`).                                                                                                                                 |
| `session.trashed`                                                                             | Invalidate lists and navigate home.                                                                                                                                                                                                    |

Because `useLive.update` addresses a run by id, events from a **subagent** run
update that child's state without touching the parent's.

### `useAppEvents()`: the app-wide stream

Mounted once in `Layout`. It subscribes to `/api/events` and invalidates the
matching query families on `agents.changed`, `skills.changed`, `data.changed`,
`projects.changed`, `workspaces.changed`, `runs.changed`, `profiles.changed` and `errors.changed`. Since these events are not replayed, it
also refetches agents, skills, errors, projects, data and the active runs **every time the stream
opens**. This is how a change made in one window, or by a tool, appears in every
other window.

### Activity indicators

`runs.changed` invalidates `runKeys.active()`, the query for
`GET /api/runs/active`: every run in progress in any session. The workbench reads it
once through `useActiveRuns()` (`hooks/useActiveRuns.ts`) and shows it two ways
(`routes/workbench/components/RunIndicator.tsx`):

- **At the top of the rail**, a summary ("N agents working", "N waiting") with a
  popover that lists the runs and links to their sessions. It covers sessions the
  tree does not show, such as those of projects that are closed.
- **On each chat row** of the tree, a spinner while a run works there, or a yellow badge
  while one waits for an approval or a form.

A run that waits is shown at once, because the user is needed. The spinner goes
through `useDebouncedFlag`: it shows after 300 ms and stays at least 600 ms, so
short or back-to-back runs do not flicker. The data is server data, so it lives
in the query cache rather than in `useLive`.

## The Chat page

`routes/chat/Chat.tsx` is the main screen, shown in a workbench tab. A segmented control
at the top of the page chooses one of five views:

| Tab             | Content                                                                |
| --------------- | ---------------------------------------------------------------------- |
| Chat            | The transcript, the composer, and the live run.                        |
| Files           | An editor-style view of every file the session can use (see below).    |
| Structured Data | The session's schemas and data.                                        |
| Workspaces      | The workspaces attached to the session (and its project's, read-only). |
| Debug           | The linear view, an event table, and each run's request.               |

**Editing and branching.** The transcript is a tree (see
[Branches](backend.md#branches)); the page shows one line of it. `routes/chat/components/Branching.tsx`
holds the controls, and the session detail's `branching` field says where each
applies: `points` (messages a branch or fork may start at), `editable` (the user's
own messages), `regenerate` (the user message that started the turn _Regenerate_
would redo) and `continuations` (live messages after the end of the line). The
controls appear only while the session is idle.

| Control           | Does                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _Edit_            | Opens a box on one of your messages. Saving uses the default from Settings → Chat → Editing (`editMode`); the ▾ menu next to _Save_ saves the other way: a _branch_ keeps the old message and what followed on a branch of its own, _in place_ overwrites the text and keeps what follows. |
| _Branch off_      | Ends the line at that message, so the next message continues from there.                                                                                                                                                                                                                   |
| _Regenerate_      | Asks the model for another reply to the last turn. The line moves back to the user message that started the turn, and the old reply stays as a branch.                                                                                                                                     |
| _Fork_            | Asks for a title (default `<title> (fork)`), then copies the line up to that message into a new session.                                                                                                                                                                                   |
| `2/3` switcher    | On a message that has siblings: previous and next branch, and a delete that moves the branch to the Trash.                                                                                                                                                                                 |
| Continuations row | Under the end of the line: the other messages that continue from it, each switching to its branch.                                                                                                                                                                                         |
| _Forked from …_   | Under a forked session's title: a link to the source (marked when it is in the Trash or deleted).                                                                                                                                                                                          |

The requests are in `useBranchActions`; each refreshes the session afterwards.
`session.transcript_changed` (from this or another window) invalidates the session
and its files and data, since they follow the line shown.

**Loading.** `["session", id]` fetches the session detail: session, project, the
messages of the line shown (with model, effort, agent version, usage, run id,
parent call id and sibling branches), `branching`, `forkedFrom`, subagent usage,
and the live-run snapshot.

**The transcript** is the stored messages with live messages merged in: an
in-flight message replaces its stored version (if continuing) or follows the
stored messages. A subagent's messages are grouped under the tool call that
started it, in a collapsible `SubagentPanel` that also shows that child's live
state and approvals. `TranscriptScroll` keeps the view pinned to the bottom while
new text arrives unless the user has scrolled away.

**Message rendering.** `MessageView` renders each role: user text, assistant
blocks (Markdown text, collapsible reasoning, tool calls), tool results
(including saved decision comments and the form the tool showed), and edit notices.
`Markdown.tsx` renders Markdown safely: raw HTML is shown as text, images are
never loaded (shown as their alt text), and links open in a new tab and only for
`http`, `https` and `mailto`.

**Attachments.** The composer's Attach button, pasting a file (a screenshot, for
example) and dropping files on the composer all upload to the session's files
at once (`routes/chat/components/Attachments.tsx`, `useAttachmentDraft`); the message then sends
the files' references. Each shows a chip with a
thumbnail for images. Only PNG, JPEG, GIF and BMP images and WAV, MP3 and FLAC
audio are taken (`attachments.ts`, which matches the backend's limits). When
llama-server says the model in use cannot read a kind of file (the model's
`inputModalities`), the composer warns and Send is disabled until they are
removed; when it does not say, attaching is allowed. A sent message shows its
files above the text, found by reference (a file that has since been deleted is
named as no longer available). The Files view has an Upload button in the
explorer header and takes files dropped on the tree (a file dropped on a folder
goes into it), previews a binary file as an image or audio player, and shows no
text editor for it. Chosen audio can be played back in the composer before it is sent. Each file in a message, and each file a tool read, has a _Default / Keep in view / Drop later_ choice that says whether the model keeps seeing it in later turns (saved per session; Default follows the agent and the Settings page). Settings has the number of kept files and the keep-by-default switch, and a section for the Media describer model and agent. After either changes, a dialog asks "Generate descriptions for N files?" with _Fill the ones with no text_, _Write all again_ and _Not now_; nothing is written before the answer. In the Files view an image or audio file shows its text under the preview, with its source ("Written by the Media Describer", "Edited by you", "Not generated" after a failure), Save text, and Retry or Generate (disabled while descriptions are off). The bytes are fetched by hash with the token and shown from object
URLs, because `<img>` and `<audio>` cannot send the token themselves.

**Voice.** Two buttons record from the microphone (`routes/chat/components/VoiceButtons.tsx`,
helpers in `audio.ts`). **Record** attaches the recording like any other file;
the user then sends it with or without text. **Record & send** sends the
message as soon as the recording has uploaded, with the text already in the
composer and any files already attached. Either button turns into a Stop button
while recording. Record & send is disabled while a run is in progress; if a run
started after the recording began, or the model cannot read some attached file,
the recording is attached and a notice says to press Send. Browsers record
WebM/Opus or MP4/AAC, which llama-server cannot read, so the page decodes the
recording, mixes it down to mono, resamples it to 16 kHz (what Gemma 4 takes) and
writes a 16-bit WAV file, which is uploaded as `voice-<date>-<time>.wav`. A
recording stops by itself at 30 seconds, Gemma 4's audio limit. Both buttons are
disabled when the model is known not to hear audio. Recording needs the user's
permission and a secure page: `https` or `localhost` (a plain `http://` address
on another host cannot use the microphone).

**Composer actions.** Send, Continue, Cancel and "Stop thinking" call the
corresponding endpoints. Sending includes the session's current model, effort and
agent choices, which the backend saves.

**Pickers.** `ModelPicker` lists the models llama-server offers with their load
status and asks the router to load one; `ReasoningPicker` shows the effort levels
the selected model's template supports; the agent picker lists the agents the
session may use. The chat page has no header of its own: the tab shows the title
(rename a chat from its menu in the tree or the Sessions table), and the status bar
shows the model, the context ring and the connection. `ContextMeter` is the ring:
the latest model call's prompt plus completion tokens against the model's context
size, live while a reply streams, with the prompt and output split on hover; in the
status bar it is drawn small (`compact`). `CopyDebugButton` is on the Debug view,
next to Refresh: _Copy_ puts the linear view on the clipboard as text, and _Export_,
in its menu, puts the whole export there as JSON.

### Answering the model

Two kinds of prompts come from a running tool call. Both stay open until
answered, and both are re-created after a page reload from the snapshot.

- **Approval** (`ApprovalDialog`). Shows the tool name and arguments. Offers
  _Allow once_, _Allow for this session_, _Always allow this tool_, and _Deny_;
  an optional comment can be typed with _once_ or _deny_. An always-asks tool offers
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

## The Files view

`FilesExplorer.tsx` is the Files tab of a session and of the global and project
pages. It looks like a code editor: a file tree on the left, the open files as
tabs on the right, a status bar below. The rules behind it (roots, tree, tabs,
what is remembered) are in `files-explorer.ts` and, for what it shares with
Structured Data, `lib/explorer.ts`; both are tested without a DOM. The frame
(`ExplorerShell.tsx`) is shared too.

The tree, tabs and editor live in `SourceExplorer.tsx`, which never calls the
API. It is given a list of `ExplorerRoot`s (id, label, why it is read-only, and
a note that makes a save ask first), each with an `ExplorerSource`
(`explorer-source.ts`): list, folders, get, write, remove, restore, folder
operations, upload, and the query keys it caches under. `FilesExplorer.tsx` is
`SourceExplorer` with one `filesSource(scope)` per root; another feature can
show its own roots in the same editor by supplying other sources. A root id is
any string; the three file roots are `FileRootId`.

**Skills.** `SkillsExplorer.tsx` is the same editor over `skillsSource`
(`skills-source.ts`): roots Built-in (read-only), Global, and on a project page
Project. A skill is a top-level folder and a file's key is `skill-name/path`, so
creating, renaming or deleting a top-level folder is doing that to the skill and
anything deeper is a change inside it (each is a new version of the skill). A
folder inside a skill exists while a file is in it, so "New folder" is refused
below the top level. A source can take any file type (`accepts`), and the tree
takes extra header buttons and menu entries (`extraTools`, `nodeActions`), which
skills use for Import (zip or folder, with a preview and a name-clash choice in
`SkillImport.tsx`), Export as zip and Copy to Global or to the project. A
file's versions are the skill's versions that contain it. Agent skills are not
shown here.

**Roots.** The tree has a root folder for each place files live that the page
can see: a session shows Session, Project (when it is in a project) and Global; a
project page shows Project and Global; the global page shows Global. Each root
holds its folders (folders first) and files. Every root is fetched with the
ordinary `files` routes of its scope; there is nothing special on the backend.

**Tree.** Mantine's `Tree`, with a header (New file, New folder, Upload, Show
deleted) and a right-click menu on roots, folders and files. A new file or
folder, and a folder rename, are typed into a name box in the tree. A new file's
type follows its extension (`.md` Markdown, `.json` JSON, anything else plain);
a new JSON file starts as `{}`, because JSON must parse. The tree is made once
the files are known, so the folders remembered as open stay open. The file in the
active tab is the selected row, and its folders are opened.

**Tabs.** A single click opens a file in an italic _transient_ tab that the next
single click replaces; a double click, or editing, keeps it. A tab is a file and
its root, so the same name in two roots gives two tabs, labelled with the root
(`notes.md · Project`). A Markdown file opens in the editor; its Preview button
opens the rendered text in a tab of its own, which follows unsaved text.

**Editing.** A text file is a CodeMirror editor (line numbers, undo, search, and
Markdown or JSON highlighting). Text typed and not saved is the tab's _draft_,
shown as a dot on the tab and "Unsaved changes" in the status bar; Save, or
Ctrl/Cmd+S, writes it. Saving a file in a root _higher_ than the page's own
scope (global above project above session) asks first. Closing a tab with a
draft asks too, and a draft whose file has changed since it was started warns and
keeps the text until the user chooses to drop it. Drafts live in the component, so
the view is kept mounted when the Chat page moves to another view, and the page
reports them with `useReportDirty`, so the workbench keeps the chat's tab mounted
and asks before it is closed or the page is reloaded.

**Read-only.** While a run is in progress, or the session is in the trash, no
root can be changed. A trashed project makes its root read-only. A deleted file
(shown when Show deleted is on) opens read-only with its last value; its
Versions dialog restores it.

**Remembered.** For each page, in `localStorage`: the open tabs, the active tab,
which folders are open, the width of the tree (dragged, or with the arrow keys,
between 180 and 520 px) and Show deleted. Unsaved text is not saved.

**Live updates.** A `files_*` tool result invalidates every scope's files, not
only the session's, because the view shows all three.

## The Structured Data view

`StructuredExplorer.tsx` is the Structured Data tab of a session and the Structured
Data page of a project and of global. It is built like the Files view: the same
frame, roots and tab rules, a tree on the left and open items as tabs on the
right. The rules behind it are in `structured-explorer.ts`.

Which roots it shows is the caller's to say. `StructuredExplorer` is the view of a
page, whose roots come from `rootsFor`; `StructuredRoots` takes any list of roots,
each with an owner (which may be an agent's), a label and, when nothing in it can
be changed, the reason. `useStructured` holds everything but the layout, so a
view with a tree of its own can use it. In an agent's root the agent's own schemas
and data can be changed; the schemas of its project, of global and the built-in
ones are shown as inherited and can be looked at, and data can be made from them,
but not changed from there.

**Tree.** Each root (Session, Project, Global, as for files) holds a **Schemas**
folder. The folder holds a row for every schema the root can make data from; each
schema holds the data the root's scope has made from it. Data whose schema is not
available here goes under **Unknown schema**, last. A schema from a higher scope
than the root is **inherited**: it is shown with a link icon and a blue name, and
a tooltip says where it comes from. (The built-in schemas are the Global root's
own.) Each root is fetched with the ordinary `data` and `schemas` routes of its
scope: the schemas it can make data from, its own schemas, and its data.

**Tabs.** A schema or a piece of data opens in a tab (a click opens a replaceable
italic tab, a double click keeps it). A schema's tab belongs to the scope it
lives in, so one schema is one tab however many roots show it. A tab shows a
**Form | JSON** toggle: a schema's form is the builder, a piece of data's form is
the one generated from its schema; JSON is a CodeMirror editor. Switching keeps
one draft; JSON that cannot be read stays in JSON with the reason. Name and
description are fields in both views.

**Editing.** Edits are in place. What was typed and not saved is the tab's draft,
kept by the view so it survives switching tabs: a dot on the tab, Save and Revert
on the toolbar. Saving something in a higher scope than the page asks first, as
for files. Saving a schema whose fields changed makes a new version, and says how
much data stays on the earlier one; out-of-date data has a **Migrate to vN**
button that fills the form against the latest version. **Versions** (and, for
schemas, **Copy…**) are on the toolbar.

**Making things.** New schema (header, or right-click on a root) and New data
(right-click a schema, or pick one and use the header) take a name in the tree
and open a tab for the rest; nothing is made until Create. Such a tab has no
saved form to come back to, so it is not remembered between visits.

**Read-only.** As in Files, every root is read-only while a run is in progress, the
project root when the project is in the trash, and a root the backend reports as
read-only. Built-in schemas and data without a schema can be looked at, not
changed.

## The Agents view

`AgentsExplorer.tsx` is the Agents page, global and a project's. It is built like the
Structured Data view: the frame of `ExplorerShell`, a tree on the left and open items
as tabs on the right. The rules behind it are in `agents-explorer.ts`.

**Tree.** The roots are **Built-in** (read-only), **Global** and, on a project's
page, **Project**; each lists its agents. An agent holds a **Skills** folder and a
**Schemas** folder. Skills holds the agent's own skill folders and files, then the
skills it inherits in groups by where they come from (Project, Global, Built-in),
read-only, with a tag on a name that another place overrides ("Overridden by
Agent"). Schemas holds the agent's own schemas, each with the agent's data made
from it, then the inherited schemas in the same groups. An agent's skills and
schemas are read when its node is first opened, not up front. New agent and Import
are buttons in the tree header; a row's menu (right-click) has New skill, New file,
New schema, New data, Delete and Export, for what the row is.

**Default agent.** Each agent row has a radio icon at its end: a filled circle-check
on the default, an empty circle (shown on hover or focus) on the others. Clicking
one makes it the default; clicking the default clears it. On the global page it is
the global default agent (locked when an environment variable sets it); on a
project's page it is the project's default, for an agent of any scope (locked when
the project is in the trash).

**Tabs.** An agent opens as a form (`AgentForm.tsx`): the system prompt in the main
area, and name, description, subagent settings and tools in a side panel. One Save
makes one version of the agent; edits not yet saved are a draft, shown with a dot on
the tab. The form edits the agent's own settings only: restoring a version of the
agent never changes its skills, schemas or data. Versions and Export are on its
toolbar. A built-in agent opens read-only with **Copy to global**, which starts a
new agent from it. A skill file opens in the text editor of the Files view, and a
schema or its data in the Structured Data tabs (an agent's root, see
`StructuredRoots` above); an inherited skill or schema opens read-only.

**Chat badge.** The agent label on a message opens the Agents page, the agent's tab
and its Versions list on that version (`stores/agentFocus.ts` carries the request).

**Tab kinds.** A project's Agents and Skills pages are the Agents and Skills tabs of
the workbench with the project as their root, not kinds of their own. Tabs saved
under the old kinds (`project-agents`, `project-skills`) are carried over when the
workbench loads (`carryOver` in `lib/workbench.ts`).

## Management pages

Each follows the same layout: a list on the left, the selected item on the right,
one page per scope. (The Files and Structured Data views are the exception; see [The Files view](#the-files-view) and [The Structured Data view](#the-structured-data-view).)

| Page                        | Edits    | Notes                                                                                                                                                                                                                           |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agents.tsx`                | Agents   | The pages around the [Agents view](#the-agents-view), the project page's default-agent select, the chat's agent picker and the agent badge on a message. The tool grant (see below) is edited in the agent's tab.               |
| `Skills.tsx`                | Skills   | The global and project pages, each the skills explorer. An agent's own skills are edited in the Agents view.                                                                                                                    |
| `Schemas.tsx`               | Schemas  | A **builder** (a field tree and the selected field's settings) or a JSON editor (CodeMirror); earlier versions can be viewed. The builder only offers features the schema subset supports, so what it produces is always valid. |
| `Data.tsx`, `DataValue.tsx` | Data     | Forms generated from the schema; the backend's validation is final and its problems are shown next to the fields. `DataValue` renders data read-only, laid out by its schema.                                                   |
| `Errors.tsx`                | (read)   | Every recorded tool error and failed run, with a link to the message in the transcript. Also shown as a panel under each chat.                                                                                                  |
| `Settings.tsx`              | Settings | All settings, global system prompt, title settings, and the tools section (see below). Shows which settings an environment variable overrides.                                                                                  |

**The agent's tools.** `ToolGrantEditor` shows tools under their group. Each group
has its own on/off box and approval choice (each tool's setting, ask for all, or
don't ask for all). Inside the MCP group, MCP tools (`mcp_<server>_<tool>`)
are grouped by server, each server collapsed by default and with the same
header; a server's box switches only that server's tools. Tools that are always on are shown locked, tools added since
the agent was last saved (`newTools`) are marked, and a switch changes the agent
between `allow` and `deny` mode. `tool-grant.ts` holds the pure logic: it works
out which tools a grant allows with the same rules as the backend and computes
the grant that results from a click on a group or a tool.

**Settings tools.** `ToolSettings` lists every tool under its group with three
settings: always on, asks before it runs, and off for the whole harness. A group's
header sets all three for the group. Changes are saved as they are made. A tool
that always asks keeps its approval fixed, and the page names the agents that
allow a tool before it is switched off.

In the session context, edits to session-scoped files and data go through
`…/sessions/:id/…` routes and become **edit messages** in the transcript. They
are disabled while a run is active.

## The Sessions page

`routes/sessions/Sessions.tsx` lists the sessions of one project, as part of the project's page,
or the standalone ones (`/sessions`, the "No project" row of the tree), in a table: title, creation
time, context use and agents. The server pages and sorts it
(`GET /api/sessions-page`): the user chooses newest or oldest first and 10, 25, 50
or 100 rows, and `sessionsPrefs.ts` remembers both in `localStorage`. Rows can be
selected, across pages; the header checkbox asks the server for every session id
(`GET /api/sessions-page/ids`) and selects the ones with no run in progress, since
a running session cannot be trashed. _Move to trash_ sends the ids to
`POST /api/sessions/trash`. A different project starts over.

## Settings

`routes/settings/Settings.tsx` is one route (`/settings/$`) whose address names the tab:
`/settings/<area>/<section>`, so changing tabs does not remount the page and a tab
can be linked to. An unknown area or section is replaced by the first one.

| Area    | Sections                                                    |
| ------- | ----------------------------------------------------------- |
| General | Models, Server, Profiles, Look & Feel                       |
| Chat    | System prompt, Instructions, Session titles, Editing, Media |
| Agents  | Subagents, Limits                                           |
| Tools   | Permissions (`ToolSettings`), MCP servers (`McpServers`)    |
| Trash   | Retention, and the trashed sessions, projects and branches  |

**Instructions** (`Instructions` in `ChatSettings.tsx`) edits the seven `…Instruction`
settings, the wording that introduces each list in the system message, each with the
placeholder that puts it elsewhere. **Look & Feel** (`LookAndFeel.tsx`) picks the theme
color from Mantine's palettes; it is kept in this browser (`stores/appearance.ts`,
per profile), not on the server.

`McpServers.tsx` lists the MCP servers the backend connects to, each with its
connection state and tools, and a form to add or edit one (stdio or http, see
[MCP servers](backend.md#mcp-servers)). `mcp-form.ts` turns its text fields (one
`KEY=value` per line for environment, one `Name: value` per line for headers)
into the stored shape and back. Settings values that an environment variable
overrides are shown as such.

### Profiles

A profile is a whole workspace of its own (see [Profiles](backend.md#profiles)),
so a switch replaces what every page shows. The switcher (`ProfileSwitcher`) is
a menu at the bottom of the rail; "Manage profiles…" opens Settings, General,
Profiles (`Profiles.tsx`): create, rename, switch, trash and restore. The
backend refuses a switch while a run is active, and the reason is shown.

The switch is not applied by the window that asked for it. The backend
announces `profile.switched` on the app stream and every window, that one
included, runs the same reset in `useAppEvents`: set the current profile
(`profile.ts`), reload the workbench's saved tabs, reset `useLive` and the query
cache, and go to the tab the new profile had active (else `/`). `main.tsx` asks
for the active profile before the first render so the saved tabs are the right
ones from the start. What is kept in localStorage for a profile (open tabs,
expanded folders, the theme colour) is saved per profile: Default keeps the old keys, other profiles add
`.p.<id>`, so switching back finds them as they were left.

## Workspaces

The Workspaces page (`Workspaces.tsx`) lists workspaces with their folder and a
writable or read-only badge; a form creates or edits one (name, folder, writable)
and a folder browser (`GET /api/fs/dirs`) picks the folder. _Move to trash_ never
touches the folder; _Show the trash_ lists them with _Restore_. Below, _Always
allowed_ lists the grants and removes one. `AttachedWorkspaces` attaches and
detaches workspaces, with _Read-only here_; it is on the project page and in the
session's Workspaces tab, where the project's are shown and cannot be detached.
Each workspace also has a _Searched parts_ section: a lazily loaded folder tree with
tri-state tick boxes (a ticked folder covers what is below it), a _The whole folder_
check box, the index status, and _Rescan_.

The approval dialog names the workspace for such a call, and its _Allow for this
session_ and _Always allow this tool_ buttons say they cover that workspace. A
workspace image or audio file a tool read is fetched with the token and shown in
the chat. Settings has the workspace read size.

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

## Styling

- **Style props first.** Spacing, size, color, typography and position go on the
  component as Mantine props (`p`, `mt`, `w`, `h`, `flex`, `bg`, `c`, `fz`, `fw`,
  `bd`, `pos`, `display`). Numbers are rem-scaled; use a token (`"md"`) when the
  value sits on the spacing scale.
- **Layout components.** `Group` for a row, `Stack` for a column, `Flex` when you
  need neither default (wrap, centering, gap). `Box` is for a plain element that
  needs style props or a `component`.
- **Theme defaults.** Repeated props live in `theme.ts` (`ActionIcon`, `Badge`,
  `Paper`); don't repeat them at call sites.
- **CSS modules for what props can't say.** Pseudo-states, `data-*` states
  (pass them with `mod`), per-side borders, cursor, overflow and white-space.
  Shared one-liners are in `styles/utilities.module.css`; tree rows share
  `components/TreeParts.tsx`, pane headers `components/PaneHeader.tsx`.
- **`style` is for runtime values only**: pixel widths from a drag, positions from
  a pointer, CSS custom properties. ESLint (`no-restricted-syntax`) flags
  prop-able keys inside `style={{}}`; disable it with a reason when a raw px
  value is required.
- **Blank lines.** ESLint (`padding-line-between-statements`) requires a blank line
  before and after `if`, `for`, `while`, `switch`, `try`, functions and classes, before
  `return` and `throw`, and after a run of `const`/`let`. `eslint --fix` adds them.
- **Tests** can't see CSS modules in jsdom. Assert `data-*` attributes and custom
  properties.

## Testing

Tests run with Vitest and `jsdom` with Testing Library (`test-setup.ts`). They
cover the stream reducer (`hooks/useEvents.test.tsx`), the linear view, the schema builder,
and the major components (approval dialog, forms, data, schemas, errors, Markdown).
