# Harness

Base framework for an AI agent harness that talks to llama.cpp's `llama-server`.
Design decisions live in the project's design document (`claude/base-design.md`).

## Packages

- `packages/core`: framework-free harness core: messages, the streamed event
  contract (Zod), the llama-server adapter, the single-call run, tool
  definitions (`defineTool`) and the agent loop.
- `packages/tools`: the tools sessions get (for now `current_date` and
  `current_time`).
- `packages/backend`: Fastify server, encrypted SQLite, migrations, settings,
  event streaming with replay.
- `packages/frontend`: React + Mantine UI (Vite).

## Documentation

- [`docs/user/`](./docs/user/README.md): how to use the app, in plain English
- [`docs/dev/`](./docs/dev/README.md): how the app is built; new contributors
  start with [`docs/dev/contributing.md`](./docs/dev/contributing.md)
- https://kyleect.github.io/storyboard/
