# AGENTS.md: `@harness/core`

The framework-free engine. It turns a transcript into a model request, streams
the response, runs the model's tool calls and reports everything as events. Read
the root `AGENTS.md` first; this file adds what is specific to core. Background:
`docs/dev/core.md`.

## Hard rules

- **No database, no HTTP server, no UI code, no Node-only APIs** in anything
  `index.ts` exports. Core must run in any JavaScript runtime, because the
  frontend imports it (aliased to its source in `packages/frontend/vite.config.ts`).
  The only file using `node:` is `llama-server/fake-llama-server.ts`, a test
  helper exported through `@harness/core/testing`, not `index.ts`.
- **core imports nothing from other workspace packages.** Its only runtime
  dependency is `zod`.
- Anything core needs from the outside (shared files, data, projects, agents,
  subagents, a schema checker, a search function) is an **interface** declared
  here and implemented by the backend. Add an interface and a `NO_*` default
  or fake rather than importing an implementation.
- `index.ts` is the public surface. A new module the other packages need must be
  re-exported there. Test helpers go through `testing.ts` instead
  (`@harness/core/testing`), so they stay out of the frontend bundle.

## Layout

```
src/
  messages.ts          provider-neutral transcript (Zod): user, assistant, tool, edit
  events.ts            the event contract between core, backend (stores/streams) and UI
  model.ts             ModelAdapter interface, request and chunk types
  run.ts, loop.ts      streamMessage / runSingleCall, and runLoop (the agent loop)
  tools.ts             Tool, defineTool, ToolContext, TOOL_GROUPS, access interfaces
  forms.ts             input forms (JSON Schema subset): read, validate, describe
  files.ts           files: access API and replay
  schemas-data.ts      schemas and data: access API and replay
  schema-features.ts   the JSON Schema subset schemas may use
  review.ts, changes.ts  describing and applying proposed changes
  decision-comments.ts, media.ts   decision comments and media folded into model requests
  message-state.ts     rebuild a message from events (shared with the frontend)
  fake-model.ts        ScriptedModel for tests
  llama-server/        adapter, models, props, embeddings, SSE reader, fake server
```

## Working in core

- **Events.** Core emits events _without_ an `id`; the backend assigns the
  increasing id when it stores them. If you add or change an event, update
  `events.ts`, the frontend's handler in `packages/frontend/src/live.ts`, and
  the event tables in `docs/dev/core.md`. Keep the reliability rules: `*.end` and
  `message.finished` carry the full authoritative content and replace what was
  built from deltas.
- **Messages.** A tool result's `isError`, `data`, `state`, `files`,
  `dataOps`, `decisionComment` and `prompt` fields are not sent to the model; only
  `content` is. Models must never see two user messages in a row because of
  harness bookkeeping: `foldDecisionComments` and `foldEdits` exist for that.
- **Tools.** Define them with `defineTool` and a Zod input. Report expected
  failures as results (`isError: true`), not exceptions. Adding a field to
  `ToolContext` means every test that builds one needs it; many tests build the
  context by hand.
- **Tool groups.** `TOOL_GROUPS` in `tools.ts` is the one list of groups, in
  display order. Changing it affects Settings, the agent editor and the
  `tools` package.
- **The llama-server adapter** speaks llama.cpp's OpenAI-compatible API
  (`/v1/chat/completions`, streaming) plus `/completion`, `/props`, `/models`
  and the reasoning-control endpoint. Cancellation is not a failure: when the
  abort signal has fired, errors are swallowed.
- **Pure and deterministic where possible.** `replay*`, `fold*`,
  `buildMessageContent` and the review/changes helpers are pure; keep them so.

## Testing

- Tests run in the Vitest `node` project (`packages/*/src/**/*.test.ts`).
- Use `ScriptedModel` (`fake-model.ts`) to script a run, `FakeSharedFiles`
  (`fake-shared-files.ts`) for shared files, and the fake llama-server for
  adapter tests. Do not call a real llama-server from a test.
- `loop.test.ts` and `run.test.ts` show the pattern for driving `runLoop` and
  checking the emitted events.

## Build

`pnpm build:core` (`tsc -b packages/core`) writes `dist/`, which the package
`exports` point at. Other packages and tests resolve `@harness/core` to the
source through aliases (`vitest.config.ts`, the frontend's Vite config), so a
build is needed only for `tsc -b` project references and running the backend.
