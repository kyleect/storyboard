# AGENTS.md: `@harness/frontend`

A single-page React app built with Vite. It is a thin client: it holds no
durable state and never talks to llama-server. Everything it shows comes from
the backend's HTTP API and event streams. Read the root `AGENTS.md` first.
Background: `docs/frontend.md`.

## Stack

React 19, Mantine 9 (components, forms, modals, notifications), TanStack Router
(routing), TanStack Query (server state), Zustand (client state), `react-markdown`
with `remark-gfm`, and CodeMirror (the JSON editor). Use these; do not add a
second UI library, router, or state manager.

## Hard rules

- **Imports from the workspace: `@harness/core` only**, for types and a few pure
  helpers such as `applyMessageEvent`. Never import `@harness/tools` or
  `@harness/backend`. Core is aliased to its source in `vite.config.ts`, so
  anything core exports at runtime ends up in the browser bundle; that is why
  core must not use Node APIs.
- **Never write a query key inline.** Build every key with the factories in
  `src/queries/` (`sessionKeys`, `agentKeys`, `fileKeys`, and so on), one file
  per feature, exported from `queries/index.ts`. Keys go from most generic to
  most specific (`["sessions", "list", { projectId }]`,
  `["sessions", "detail", id]`) so a mutation or stream event can invalidate
  exactly what it changed. A new feature gets a new factory, and
  `queries/keys.test.ts` pins how far each prefix reaches.
- **The cache holds what is stored; `useLive` (Zustand, `live.ts`) holds what is
  happening right now.** When something finishes, update or invalidate the
  cache and clear the live file. Do not keep server data in `useState` or in
  a second store.
- **All HTTP goes through `src/api.ts`**, which adds the bearer token. EventSource
  cannot set headers, so stream URLs add `?token=`. Do not call `fetch` for
  `/api` elsewhere, and never put the token anywhere but `sessionStorage` and
  those two places. The token arrives once in the URL fragment and is removed
  from the address bar.
- **Render untrusted content safely.** `routes/Markdown.tsx` shows raw HTML as
  text, never loads images, and opens links in a new tab only for `http`,
  `https` and `mailto`. Route all model and user Markdown through it. Binary
  files (images, audio) are fetched with the token and shown from object URLs,
  because `<img>` and `<audio>` cannot send the token.

## Layout

```
src/
  main.tsx             providers, router, route table (every page renders inside Layout)
  api.ts               token handling, typed API client, stream URLs
  queries/             query-key factories, one file per feature
  live.ts              live run state (Zustand) and the two event-stream hooks
  picked.ts            the project picked in the navbar (saved in localStorage)
  linear.ts, debug.ts  debug export to linear view; clipboard helpers
  schema-builder.ts    JSON Schema <-> editable field tree
  tool-grant.ts        tool grants: which tools a grant allows, and the edits a click makes
  attachments.ts, audio.ts   allowed file types; voice recording to 16 kHz mono WAV
  routes/              pages and components (Chat, Files, Agents, Skills, Schemas, Data,
                       Errors, Settings, Workspaces, McpServers, ...)
  test-setup.ts        jsdom stand-ins for Mantine
```

## Conventions

- Relative imports have **no file extension** (unlike the other packages).
- Pages and components live in `routes/` as `Name.tsx` with a `Name.test.tsx`
  beside them.
- A new page needs a route in `main.tsx` and, if it shows server data, a query
  factory and the matching invalidation in the event handlers.
- **Live events.** `useSessionEvents` (one session's stream) and `useAppEvents`
  (the app-wide stream, mounted once in `Layout`) are the only event
  consumers. The session handler is a switch on `event.type`; when core adds
  an event, handle it there. App events are not replayed, so the data they
  invalidate is also refetched whenever the stream opens. Both hooks
  reconnect with exponential backoff.
- **`tool-grant.ts` mirrors backend logic** (`packages/backend/src/tool-grants.ts`):
  it must decide which tools a grant allows by the same rules. If you change one,
  change the other and their tests.
- **`attachments.ts` mirrors backend limits** on accepted image and audio types
  (`packages/backend/src/media-detect.ts`); keep them in step.

## Testing

- Tests run in the Vitest `frontend` project: jsdom, Testing Library, and
  `src/test-setup.ts` (stand-ins for `matchMedia`, `ResizeObserver`,
  `document.fonts` and `scrollIntoView`, which Mantine needs). Plain-logic
  tests in `*.test.ts` run in the `node` project.
- Component tests wrap the component in `MantineProvider` (and
  `ModalsProvider` / `QueryClientProvider` where needed) and stub calls with
  `vi.spyOn(api, "...")`; see `routes/Skills.test.tsx` for the pattern.
- Check keys with `queries/keys.test.ts` when you add a factory.

## Running and building

```sh
pnpm dev:frontend              # from the root: http://localhost:5173, proxies /api
pnpm --filter @harness/frontend build
```

The dev server needs the backend running (`pnpm dev:backend`); open the
`http://localhost:5173/#token=...` link it prints. `HARNESS_BACKEND_URL`
points the proxy at a different backend (default `http://127.0.0.1:4317`).
Type checking for this package is `tsc -p packages/frontend` (part of
`pnpm typecheck`); it is not part of `tsc -b`.
