# Development

## Requirements

- Node 22.22 or later (chokidar, which watches workspace folders, needs it), pnpm 10.
- A running `llama-server`, started with `--jinja` so tool calls work. In router mode, pick a model in each session's
  model picker, or set a default model in Settings. Picking a model in a session
  asks the router to load it. Reasoning effort works the same way.

### Multimodal models

To attach images and audio, the model must be loaded with its multimodal
projector (an `mmproj-*.gguf` file). For Gemma 4 E4B, both images and audio are
supported.

- Router mode (`--models-dir`): put the model and its projector in one
  subdirectory, for example `~/llm/models/gemma-4-E4B-it/` holding
  `gemma-4-E4B-it-<quant>.gguf` and `mmproj-<name>.gguf`.
- A single model: `llama-server -m model.gguf --mmproj mmproj-<name>.gguf`.
- Images and audio take context; consider `-c 16384` or more.

The model list shows what each model can read (`architecture.input_modalities`
from `GET /models`); the chat only offers to attach what the model in use reads.
Images may be PNG, JPEG, GIF or BMP; audio may be WAV, MP3 or FLAC. Gemma 4
takes up to 30 seconds of audio per clip (about 25 tokens a second). The Record
button works only on `https` or `localhost`.

## Run (development)

```sh
pnpm install
pnpm dev:backend     # terminal 1
pnpm dev:frontend    # terminal 2
```

The backend prints `Frontend (dev): http://localhost:5173/#token=...`.
Open that address. The token is moved out of the address bar and kept for the
browser tab. It is stored in `<data dir>/api.token`, so it stays the same when
the backend restarts (for example when `tsx watch` reloads it): an open page
reconnects on its own and the printed link keeps working. Delete that file to
get a new token.

### Backend environment variables

| Variable                       | Default                                      | Purpose                                                                             |
| ------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `HARNESS_DATA_DIR`             | `~/Library/Application Support/harness`      | Folder for the database, key file and runtime file                                  |
| `HARNESS_DB_PATH`              | `<data dir>/harness.db`                      | Encrypted database                                                                  |
| `HARNESS_KEY_FILE`             | `<data dir>/harness.key`                     | Database key; created on first run (mode 600)                                       |
| `HARNESS_LLAMA_URL`            | stored setting, else `http://127.0.0.1:8080` | llama-server address                                                                |
| `HARNESS_MODEL`                | stored setting, else empty (not sent)        | Default model for sessions with none chosen                                         |
| `HARNESS_REASONING_EFFORT`     | stored setting, else empty (not sent)        | Default reasoning effort for sessions with none chosen (`none` turns reasoning off) |
| `HARNESS_PORT`                 | stored setting, else `4317`                  | Backend port                                                                        |
| `HARNESS_LOOP_LIMIT`           | stored setting, else `20`                    | The most model calls one run makes                                                  |
| `HARNESS_TRASH_RETENTION_DAYS` | stored setting, else `30`                    | Days in the trash before an item is deleted at startup (`0`: never)                 |

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
