# Story Harness: Base Architecture

|                  |            |
| ---------------- | ---------- |
| **Author**       | TBD        |
| **Reviewers**    | TBD        |
| **Status**       | Draft      |
| **Last updated** | 2026-10-30 |

## 1. Summary

Story Harness is a desktop application for writing short stories with locally hosted language models. This document covers the base harness: the runtime that sends prompts to a model, streams output to the UI, runs tools, and exposes the extension points a story-writing layer will build on. The story layer itself is out of scope.

The UI stack (Tauri, React, Mantine), the language (TypeScript), and the initial model server (llama.cpp's `llama-server`) are decided. Thirteen architecture questions remain open and are laid out in section 7 with their options and trade-offs.

## 2. Background and motivation

Story creation in this system combines model text generation with a set of parameters that constrain it. The details of those parameters and of story structure are a separate design.

The harness runs against models served locally by llama.cpp. Other OpenAI-compatible servers may be supported later.

A throwaway prototype exists. It is not the basis for this design, and none of its choices carry over.

Further motivation: _to be filled in._

## 3. Goals and non-goals

### Goals

- Send prompts to a model and stream output back to the UI.
- Support constraining generation with parameters. The base provides the mechanism; the parameters themselves belong to the story layer.
- Provide clear extension points for the story layer.

### Non-goals

- Story parameters, constraints and story structure.
- Agent roles, prompts and tools specific to story writing.
- Model servers other than llama.cpp in the first version.
- UI beyond what is needed to use and test the base.

## 4. Requirements

| ID  | Requirement                                              |
| --- | -------------------------------------------------------- |
| R1  | TypeScript for the backend and the frontend.             |
| R2  | Tauri as the desktop application shell.                  |
| R3  | Mantine React components for the UI. This implies React. |
| R4  | Compatibility with llama.cpp's `llama-server` API.       |
| R5  | Generation can be constrained by a set of parameters.    |

## 5. Architecture overview

The base consists of five logical components. No technology is assigned to them until the open decisions in section 7 are settled.

```
+--------------+       +-----------------+       +-----------------+       +----------------+
| Desktop UI   | ----> | Harness core    | ----> | Model adapter   | ----> | llama-server   |
| Tauri +      |  D3   | location: D1,   |       | API: D5         |  D5   | local model    |
| Mantine      |       | runtime: D2     |       |                 |       | server         |
+--------------+       +-----------------+       +-----------------+       +----------------+
                          ^          |
                 plugs in |          | persists
                          |          v
                 +- - - - - - - +   +-----------------+
                 | Story layer  |   | Storage         |
                 | (future)     |   | D7              |
                 +- - - - - - - +   +-----------------+
```

Requests flow left to right; output streams back along the same path. The story layer (dashed) is not part of the base.

| Component     | Responsibility                                                              |
| ------------- | --------------------------------------------------------------------------- |
| Desktop UI    | Presents sessions and streamed output; sends user input.                    |
| Harness core  | Runs agents: model calls, tool execution, session state, event emission.    |
| Model adapter | Translates between the harness's message format and the model server's API. |
| llama-server  | Serves the model. External to this project.                                 |
| Storage       | Persists sessions and other data (scope open, D7).                          |

## 6. Design decisions (made)

Rationale for each decision is to be filled in.

### 6.1 Model server: llama.cpp first

**Decision:** The first version targets llama.cpp's `llama-server` only. Support for other OpenAI-compatible servers can be added later.
**Rationale:** _To be filled in._

### 6.2 Provider-neutral message format

**Decision:** The harness uses its own message format, independent of any model server's wire format. Adapters translate at the boundary.
**Rationale:** _To be filled in._

### 6.3 Tool definitions

**Decision:** Tools follow the standard agent-harness shape: a name, a description, and an input schema.
**Rationale:** _To be filled in._

### 6.4 Per-session state

**Decision:** Each session carries state that the harness persists and that tools can read and write.
**Rationale:** _To be filled in._

### 6.5 Agent definitions

**Decision:** Agent definitions follow the conventions of common agent harnesses. Details are to be designed.
**Rationale:** _To be filled in._

### 6.6 Testing approach

**Decision:** Testing starts with a scripted fake model and a fake `llama-server` that replays its streaming format.
**Rationale:** _To be filled in._

### 6.7 Layered configuration

**Decision:** Configuration is read from several sources: environment variables, a config file or SQLite database, and command-line arguments. Details are open in D12.
**Rationale:** _To be filled in._

## 7. Open decisions

Each entry lists the options and trade-offs considered. No option is recommended. D1 is first because it determines whether D2 to D4 apply.

### D1. Where the harness logic runs

| Option                                                       | Advantages                                                                                               | Disadvantages                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. In the webview, as frontend TypeScript                    | Single process; nothing extra to package                                                                 | Runs stop if the window reloads; file access only through Tauri plugins; requests to `llama-server` are subject to the webview's cross-origin rules |
| B. A separate TypeScript process launched by Tauri (sidecar) | Full runtime APIs; runs survive UI reloads; harness can run without the app (scripts, tests, batch jobs) | A second program to build and ship; requires a UI-to-process channel (D3)                                                                           |

Running agent logic in Rust is excluded by R1.

Open questions:

- Must the harness run without the desktop app, for example from a CLI or batch job?
- Must a long-running generation survive a window reload or close?

### D2. JavaScript runtime (applies if D1 = B)

| Option | Advantages                                                                                           | Disadvantages                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Node   | Broadest library compatibility                                                                       | Single-file packaging uses Node SEA; the prototype's binary was 134 MB. Otherwise Node must be installed on the user's machine |
| Bun    | Runs TypeScript natively; built-in test runner and SQLite; `bun build --compile` produces one binary | Some Node APIs and native modules behave differently                                                                           |
| Deno   | Runs TypeScript natively; permission model; `deno compile` produces one binary                       | npm compatibility layer; smaller Deno-first ecosystem                                                                          |

Binary sizes for Bun and Deno have not been measured.

Open questions:

- Must the application ship self-contained, or may it require an installed runtime?
- Are there runtime preferences or exclusions?

### D3. UI-to-harness transport (applies if D1 = B)

| Option                                                         | Advantages                                                             | Disadvantages                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Local HTTP, streaming over SSE or WebSocket                    | Testable with standard tools; UI can be developed in a regular browser | Opens a localhost port, which needs a per-launch token                  |
| Standard input/output, relayed to the UI by Tauri's Rust layer | No open port                                                           | All traffic passes through Rust relay code; UI cannot run outside Tauri |

Open question:

- Is a token-protected localhost port acceptable?

### D4. HTTP framework (applies if D3 = HTTP)

| Option                           | Notes                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| None (runtime's built-in server) | No dependency; routing and validation written by hand                                                                                          |
| Express                          | Long-standing default; middleware-based                                                                                                        |
| Fastify                          | Built-in schema validation and serialization                                                                                                   |
| Hono                             | Web-standard Request/Response; runs on Node, Bun and Deno; about 32,600 GitHub stars ([OSSInsight](https://ossinsight.io/analyze/honojs/hono)) |
| Elysia                           | Bun only                                                                                                                                       |

Adoption figures for the other options have not yet been verified.

Open question:

- Are there framework preferences or exclusions?

### D5. llama-server API surface

| Option                                   | Advantages                                                                                                                                  | Disadvantages                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| OpenAI-compatible `/v1/chat/completions` | Server applies the model's chat template; supports tool calls (requires `--jinja`); eases later support for other OpenAI-compatible servers | Prompt control limited to what the template allows                             |
| Native `/completion`                     | Raw prompt in, raw text out; full control of templating                                                                                     | Prompt templates maintained per model; tool calling implemented by the harness |
| Both, selected per call                  | Chat for conversation, raw completion for continuation                                                                                      | Two code paths                                                                 |

The chat endpoint also accepts llama.cpp-specific fields such as `grammar` (GBNF), `json_schema`, `min_p`, `top_k` and `repeat_penalty` ([example client](https://docs.rs/crate/daimon-provider-local/latest/source/src/llamacpp.rs)). This needs confirming against the llama.cpp version in use.

Open questions:

- Is raw text continuation, without a chat template, required?
- Is constrained output (GBNF grammars or JSON schema) required?
- Does the application manage the `llama-server` process, or connect to an externally run instance?
- One model at a time, or several?

### D6. Execution model

| Option      | Description                                                          |
| ----------- | -------------------------------------------------------------------- |
| Single call | One model request per action; application code decides the next step |
| Agent loop  | The model calls tools repeatedly until it stops                      |
| Pipeline    | A fixed sequence of steps, each a model call or code                 |
| Combination | The base supports more than one of the above                         |

Tool-calling quality varies widely across local models.

Open questions:

- Is tool calling required in the base?
- Where do parameters act: prompt text, sampling settings, grammars, post-generation checks? Which of these must the base support generically?

### D7. Persistence

| Option                         | Advantages                                     | Disadvantages                      |
| ------------------------------ | ---------------------------------------------- | ---------------------------------- |
| None in the base               | Nothing to design now                          | Deferred work                      |
| Plain files (JSON or Markdown) | Human-readable; diffable; version-controllable | No querying                        |
| SQLite                         | Queries and indexes                            | Binary file; driver depends on D2  |
| Tauri store plugin             | No backend required                            | Key-value only; coupled to the app |

Open question:

- What must be persisted (outputs, transcripts, parameter sets, run history), and must it be human-readable?

### D8. Schema and validation library

Options: zod, Valibot, TypeBox, ArkType, or TypeScript types without runtime validation. Relevant where tool inputs or parameters need JSON Schema output or runtime checks.

Open question:

- Do parameters need runtime validation or schema-generated UI?

### D9. Frontend libraries beyond Mantine

Open: bundler (Tauri documents Vite for React), state management (React state, Zustand, TanStack Query, Redux), routing (none, React Router, TanStack Router), and additional Mantine packages (form, notifications, modals, others).

Open question:

- Are there library preferences or exclusions?

### D10. Repository structure and tooling

Open: single package or workspace; package manager (npm, pnpm, Yarn, Bun); test runner (Vitest, Jest, node:test, bun test); lint and format (ESLint with Prettier, or Biome).

Open question:

- Are there existing standards to follow?

### D11. Platforms and distribution

Open questions:

- Target operating systems: Windows, macOS, Linux?
- Installers and auto-update, or run from source initially?
- Is fully offline operation required?

### D12. Configuration details

Layered configuration is decided (6.7). Open questions:

- Config file or SQLite database for stored settings?
- If a file, which format: JSON, TOML or YAML?
- Precedence between sources. A common order is CLI arguments, then environment variables, then stored configuration.
- May the UI change settings, and if so, which source does it write to?

### D13. Streamed event contract

During a run, the harness core emits a sequence of typed events (for example: run started, text delta, reasoning delta, tool called, tool result, run finished, run failed). The UI relay, the UI, logging and tests all consume this one contract.

| Option                                  | Notes                                           |
| --------------------------------------- | ----------------------------------------------- |
| Custom event types                      | Fits the harness exactly; maintained in-house   |
| AG-UI (Agent-User Interaction Protocol) | Open protocol for streaming agent events to UIs |
| Vercel AI SDK stream protocol           | Coupled to that SDK's UI helpers                |
| No streaming contract                   | Final results only; no live output              |

Open questions:

- Custom events or an existing protocol?
- Should events be persisted so runs can be replayed or inspected?

## 8. Future work

- **Continue in a new session.** An alternative to context compaction: a new session can selectively search prior sessions rather than loading them fully into context.
- **Additional model servers.** Other OpenAI-compatible servers beyond llama.cpp.
- **Story layer.** Parameters, constraints, story structure and story-specific agents, in a separate design.
