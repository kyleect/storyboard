# AGENTS.md

Guidance for AI coding agents working in this repository. Each package has its
own `AGENTS.md` with the rules for that package; read the one for the package
you are changing as well as this file.

## What this is

A harness for running LLM agents against a local llama.cpp `llama-server`. A
user chats with an agent in a browser UI; the agent can call tools, ask the
user questions, keep files and notes, work with structured data and hand work
to other agents. Everything is stored in one encrypted SQLite database.

```
packages/
  core/       @harness/core      framework-free engine: messages, events, agent loop, tool API, llama-server adapter
  tools/      @harness/tools     every tool an agent can call
  backend/    @harness/backend   Fastify server, SQLite, run manager, migrations
  frontend/   @harness/frontend  React + Mantine UI (Vite)
```

Dependencies point one way: `core` ← `tools` ← `backend`. The frontend imports
`@harness/core` (types and a few pure helpers) and nothing else from the
workspace. It never imports `tools` or `backend`.

## Commands

Run from the repository root. Node 22.22+ and pnpm 10 are required
(`packageManager` and `engines` in `package.json`).

```sh
pnpm install
pnpm test            # Vitest: all packages (node and jsdom projects)
pnpm typecheck       # tsc -b (core, tools, backend) and tsc -p packages/frontend
pnpm lint            # ESLint
pnpm format:check    # Prettier (pnpm format writes)

pnpm dev:backend     # builds tools, then runs the backend with tsx watch
pnpm dev:frontend    # Vite dev server on http://localhost:5173
```

Run a single test file with `pnpm vitest run path/to/file.test.ts`.

Before you finish a change, run `pnpm test`, `pnpm typecheck`, `pnpm lint` and
`pnpm format:check`. Report any failure or warning you see; do not work around
it without understanding it.

Running the app itself needs a `llama-server` started with `--jinja` (needed
for tool calls). The tests do not: they use a scripted model and a fake
llama-server (`@harness/core/testing`).

## Conventions

- **TypeScript everywhere**, strict, with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and `verbatimModuleSyntax` on (see
  `tsconfig.base.json`). Use `import type` for type-only imports.
- **ESM.** Packages are `"type": "module"`. In `core`, `tools` and `backend`
  relative imports end in `.js` (`from "./store.js"`). The frontend's relative
  imports have no extension.
- **Zod** (4.x) defines every shape that crosses a boundary: messages, events,
  tool inputs, request bodies, settings.
- **Formatting is Prettier's defaults** (no config file). Do not hand-format;
  run `pnpm format`.
- **Dependencies are pinned** to exact versions in most `package.json` files.
  Add new ones with `pnpm add --filter <package> <name>` and keep the pin style
  of the file you edit. Do not hand-edit `pnpm-lock.yaml`.
- **Tests sit next to the code** as `*.test.ts` (and `*.test.tsx` in the
  frontend). New behavior comes with a test.
- Comments explain why, and often cite the design decision behind the code
  (for example "tools design, section 6", "D15"). Those design documents are
  not in this repository; keep the existing citations when you edit nearby
  code, and do not invent new ones.

## Design principles to preserve

These run through the whole codebase (details in `docs/README.md`).

- **The transcript is the source of truth.** A session's messages are stored.
  Session-scoped files, notes, schemas and data are rebuilt by replaying
  changes recorded on messages, not kept in tables of their own.
- **Everything is an event.** A run communicates only by emitting events. The
  backend stores each event before sending it, so a client can replay what it
  missed.
- **Core depends on interfaces; the backend implements them over SQL.** Core
  has no database, no HTTP server and no UI code.
- **The user and the model can do the same things**, through the same stores,
  and every change is versioned and attributed.
- **Nothing is hard-deleted by accident.** Entries, agents, skills, schemas
  and data keep every version and are soft-deleted; sessions and projects go
  to a trash first.

## Things to know before editing

- **Migrations are append-only.** Never edit a migration that has been
  applied; see `packages/backend/migrations/AGENTS.md`.
- **Security-sensitive files.** The backend binds to loopback only, requires
  an API token on every `/api/` route, and encrypts the database. Do not log
  the token or the database key, and do not log query strings.
- **Built-in records** (the Dispatcher agent, built-in schemas and skills) are
  inserted by migrations and flagged `builtin = 1`.
- **`patches/`** holds a patch for `better-sqlite3-multiple-ciphers` applied by
  pnpm (`patchedDependencies` in `pnpm-workspace.yaml`). Changing that
  dependency's version means regenerating the patch.
- **`docs/` is published** to https://kyleect.github.io/storyboard/ (it
  includes Mermaid rendering in `docs/_includes/head-custom.html`). When you
  change behavior the docs describe, update the matching page in `docs/`:
  `core.md`, `tools.md`, `backend.md`, `frontend.md`, or the glossary. The docs
  can still fall behind the code; when they disagree, the code is right, and
  fixing the doc is part of the change. `docs/contributing.md` is the guide for
  new contributors. There is no `AGENTS.md` inside `docs/` because that folder
  is the site's source.
- Do not commit build output (`dist/`) or `.patch` files other than those
  under `patches/` (see `.gitignore`).
