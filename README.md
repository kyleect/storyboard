# Harness

Base framework for an AI agent harness that talks to llama.cpp's `llama-server`.
Design decisions live in the project's design document (`claude/base-design.md`).

## Packages

- `packages/core`: framework-free harness core: messages, the streamed event
  contract (Zod), the llama-server adapter, the single-call run.
- `packages/backend`: Fastify server, encrypted SQLite, migrations, settings,
  event streaming with replay.
- `packages/frontend`: React + Mantine UI (Vite).

## Requirements

- Node 22.12 or later, pnpm 10.
- A running `llama-server`. In router mode, pick a model in each session's
  model picker, or set a default model in Settings.

## Run (development)

```sh
pnpm install
pnpm dev:backend     # terminal 1
pnpm dev:frontend    # terminal 2
```

The backend prints `Frontend (dev): http://localhost:5173/#token=...`.
Open that address. The token is moved out of the address bar and kept for the
browser tab.

### Backend environment variables

| Variable            | Default                                      | Purpose                                            |
| ------------------- | -------------------------------------------- | -------------------------------------------------- |
| `HARNESS_DATA_DIR`  | `~/Library/Application Support/harness`      | Folder for the database, key file and runtime file |
| `HARNESS_DB_PATH`   | `<data dir>/harness.db`                      | Encrypted database                                 |
| `HARNESS_KEY_FILE`  | `<data dir>/harness.key`                     | Database key; created on first run (mode 600)      |
| `HARNESS_LLAMA_URL` | stored setting, else `http://127.0.0.1:8080` | llama-server address                               |
| `HARNESS_MODEL`     | stored setting, else empty (not sent)        | Default model for sessions with none chosen        |
| `HARNESS_PORT`      | stored setting, else `4317`                  | Backend port                                       |

`HARNESS_BACKEND_URL` tells the frontend dev server where the backend is
(default `http://127.0.0.1:4317`).

Stop the backend with Ctrl+C: running generations end as interrupted and
their partial text is kept.

## Checks

```sh
pnpm test         # Vitest
pnpm typecheck
pnpm lint
pnpm format:check
```

## Notes

- `patches/better-sqlite3-multiple-ciphers@13.0.3.patch` adds a `types` entry
  to the driver's `exports` so TypeScript finds its bundled type definitions.
- The database driver ships prebuilt binaries (N-API, so any Node version)
  for macOS, Linux and Windows, so its node-gyp build script is skipped
  (`ignoredBuiltDependencies` in `pnpm-workspace.yaml`). No compiler needed.
- Migrations are read from `packages/backend/migrations` at startup. Embedding
  them in a bundle waits on the packaging decision.
