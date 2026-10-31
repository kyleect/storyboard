# Story Harness: Base Architecture

|                  |            |
| ---------------- | ---------- |
| **Author**       | TBD        |
| **Reviewers**    | TBD        |
| **Status**       | Draft      |
| **Last updated** | 2026-10-30 |

## 1. Summary

Story Harness is a desktop application for writing short stories with locally hosted language models. This document covers the base harness: the runtime that sends prompts to a model, streams output to the UI, runs tools, and exposes the extension points a story-writing layer will build on. The story layer itself is out of scope.

The UI stack (Tauri, React, Mantine), the language (TypeScript), and the initial model server (llama.cpp's `llama-server`) are decided. Several architecture questions remain open and are laid out in section 7 with their options and trade-offs.

## 2. Background and motivation

Story creation in this system combines model text generation with a set of parameters that constrain it. The details of those parameters and of story structure are a separate design.

The harness runs against models served locally by llama.cpp. Other OpenAI-compatible servers may be supported later.

The harness is also intended as a template for future harness projects, which may have a CLI or other front ends. For that reason the harness core, the backend and the frontend are kept decoupled from each other.

A throwaway prototype exists. It is not the basis for this design, and none of its choices carry over.

Further motivation: _to be filled in._

## 3. Goals and non-goals

### Goals

- Send prompts to a model and stream output back to the UI.
- Support constraining generation with parameters. The base provides the mechanism; the parameters themselves belong to the story layer.
- Provide clear extension points for the story layer.
- Keep the harness core, backend and frontend decoupled, so the same harness can serve a desktop UI, a CLI or other front ends.
- Let a generation keep running when the UI reloads or closes, and let a session be resumed later.

### Non-goals

- Story parameters, constraints and story structure.
- Agent roles, prompts and tools specific to story writing.
- Model servers other than llama.cpp in the first version.
- UI beyond what is needed to use and test the base.

## 4. Requirements

| ID  | Requirement                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | TypeScript for the backend and the frontend.                                                                                                                    |
| R2  | Tauri as the desktop application shell.                                                                                                                         |
| R3  | Mantine React components for the UI. This implies React.                                                                                                        |
| R4  | Compatibility with llama.cpp's `llama-server` API.                                                                                                              |
| R5  | Generation can be constrained by a set of parameters.                                                                                                           |
| R6  | The harness can run without the webview (for example from a CLI).                                                                                               |
| R7  | A long-running generation survives a UI reload or close.                                                                                                        |
| R8  | A session can be resumed after the fact.                                                                                                                        |
| R9  | The application ships as self-contained binaries; users do not install a JavaScript runtime. (Under review in D15.)                                             |
| R10 | A UI can reattach to a run already in progress and receive the events it missed.                                                                                |
| R11 | The SQLite database is encrypted at rest. Encryption is provided at the SQLite level (an extension or an encrypted build), not implemented in application code. |

## 5. Architecture overview

The base consists of five logical components. No technology is assigned to them until the open decisions in section 7 are settled.

```
+--------------+       +-----------------+       +-----------------+       +----------------+
| Desktop UI   | ----> | Harness core    | ----> | Model adapter   | ----> | llama-server   |
| Tauri +      |  D3   | own process,    |       | API: D5         |  D5   | local model    |
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

The harness process can be started in two ways. The desktop app launches it as a bundled helper program (Tauri calls this a sidecar), or a user runs it directly from a terminal as a command-line tool (CLI). Both run the same harness core. Whether they are one binary with two modes or two binaries is open (D15).

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

### 6.8 Harness runs as a separate TypeScript process (D1)

**Decision:** The harness runs as its own TypeScript process, launched by Tauri when the desktop app is used, rather than inside the webview.
**Rationale:** The harness must be able to run without the webview, since it will serve as a template for future projects that may have a CLI or other front ends, and the harness, backend and frontend are to be decoupled. Generations must survive a UI reload or close, and sessions must be resumable, which a webview-hosted harness cannot provide.

### 6.9 Runtime: Node (D2)

**Decision:** The harness process runs on Node. Distribution is self-contained binaries (R9).
**Rationale:** To be filled in. Stated preference: Node is the ideal runtime.

### 6.10 Transport: local HTTP with streaming (D3)

**Decision:** The UI talks to the harness process over local HTTP, with server output streamed using server-sent events (SSE). Commands, including cancelling a run, are ordinary HTTP requests. The stream's auth token is passed in the URL.
**Rationale:** To be filled in.

### 6.11 Database access: SQL with migrations, no ORM (D16, D17)

**Decision:** The database layer uses SQL queries and versioned schema migrations, not an ORM. The migration tool is open (D17).
**Rationale:** To be filled in.

### 6.12 SQLite driver: better-sqlite3-multiple-ciphers, SQLCipher-compatible mode (D16)

**Decision:** The database uses `better-sqlite3-multiple-ciphers` in its SQLCipher-compatible mode, so databases can be read with SQLCipher tools.
**Rationale:** To be filled in. Stated: SQLCipher is preferred, and the library "seems solid".

### 6.13 Encryption key supplied through an environment variable (D18)

**Decision:** The database key is supplied through an environment variable. It is never passed as a command-line argument.
**Rationale:** To be filled in. Stated: the whole system runs on localhost.

### 6.14 HTTP framework: Fastify (D4)

**Decision:** The harness process uses Fastify as its HTTP framework.
**Rationale:** To be filled in. Stated: familiarity with the name.

**Routes are thin adapters over the harness core.** All harness logic (loading sessions, calling the model, saving, producing events) lives in the harness core, which has no knowledge of HTTP. Fastify routes only translate requests into core calls and core events into SSE. The core is therefore reusable by a CLI or other front ends, and the framework can be replaced by rewriting only the route layer.

### 6.15 Schema and validation library: Zod (D8)

**Decision:** Zod is the schema and validation library.
**Rationale:** To be filled in.
**Scope:** Runtime validation and schema-generated UI for story parameters are out of scope for the base.

### 6.16 llama-server API: chat completions plus a raw-prompt endpoint (D5)

**Decision:** The harness calls `/v1/chat/completions` for agent-style chat, tool calls, JSON-constrained results and continuing a message by prefill. It also calls a raw-prompt endpoint for raw continuation (continuing plain text with no chat template). Which raw-prompt endpoint (native `/completion` or `/v1/completions`) is open.
**Rationale:** To be filled in. Stated: agent-style chat with tool use; a "continue" action on a message; raw continuation "would be very useful in many cases"; constrained JSON results for use outside the chat (webview or CLI).
**Environment (stated):** The application connects to a `llama-server` that the user runs; it does not start or stop it. The server runs in router mode. One model is in use at a time. Only llama.cpp is supported; other OpenAI-compatible servers are not a goal.

## 7. Open decisions

Each entry lists the options and trade-offs considered. No option is recommended. D1 is decided (6.8), so D2 to D4 apply.

### D1. Where the harness logic runs

Decided: a separate process. See 6.8.

### D2. JavaScript runtime

Decided: Node, shipped self-contained. See 6.9. The packaging mechanism is D15.

### D3. UI-to-harness transport

Decided: local HTTP with SSE streaming, and the stream's auth token in the URL (6.10).

Reattaching to a run in progress (R10) uses SSE's event IDs: each event carries an ID, and a reconnecting client sends the last ID it received. The harness must keep events with IDs, in memory or persisted (D13).

Consequence: a token in the URL can end up in logs, so the server must not log query strings.

### D4. HTTP framework

Decided: Fastify, with routes as thin adapters over the harness core (6.14). The options considered are kept below.

The API is small now and expected to grow. The base is meant to serve as a template for future harnesses.

| Option                        | Notes                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (Node's built-in `http`) | No dependency. Routing, parsing and validation written by hand; growth means writing a router                                                                                                                                                                                             |
| Express                       | Largest ecosystem, in use since 2010. Typing comes from community definitions and varies across middleware. Middleware chains can become complex as an application grows ([Better Stack comparison](https://betterstack.com/community/guides/scaling-nodejs/fastify-vs-express-vs-hono/)) |
| Fastify                       | Built-in schema validation and serialization, with typing from request to response per the same article. A plugin architecture that the article says scales from simple APIs to complex services; the official organization maintains many plugins                                        |
| Hono                          | TypeScript-first, with typed routes. Middleware chains and pattern-matched routing. Newer and fast-evolving. About 32,600 GitHub stars ([OSSInsight](https://ossinsight.io/analyze/honojs/hono)). The comparison article does not address large-application structure                     |

SSE support does not separate the options. Any of them can write SSE frames by hand. Libraries and helpers:

- Hono has a built-in SSE helper.
- `better-sse` is dependency-free and written in TypeScript. It works with the Node `http` module and Fetch-based frameworks, including Express and Hono; Fastify support is inferred from that. It accepts the client's last event ID and supports broadcasting to channels, but it does not store past events ([README](https://github.com/MatthewWid/better-sse)).
- A Fastify SSE plugin with `Last-Event-ID` replay was in an unreleased pull request when checked ([PR](https://github.com/fastify/sse/pull/1)). Community plugins exist and were not evaluated.

Storing events for replay (R10) is the harness's job whichever option is chosen (D13).

Not verified: OpenAPI generation, testing support, and the star counts for Express and Fastify.

### D5. llama-server API surface

Decided: chat completions plus a raw-prompt endpoint (6.16). Open: which raw-prompt endpoint. Findings are from llama.cpp's documentation and source (master); no live server was run, so none of this is tested end to end.

| Endpoint               | Findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/chat/completions` | The server applies the model's chat template (ChatML if it has no supported one). The README makes "no strong claims of compatibility with OpenAI API spec". Accepts `response_format`, a top-level `json_schema` and a top-level `grammar` (not both `json_schema` and `grammar`); `/completion`-specific fields such as `mirostat` are accepted. Tool calls need `--jinja`: native formats for the models in the function-calling doc, a less efficient generic fallback otherwise; `parallel_tool_calls` is off by default. A custom `grammar` is rejected when tools are present; how `json_schema` or `response_format` combine with tools was not checked. If the last message has the role `assistant`, the server continues it (assistant prefill, on by default, `--no-prefill-assistant` turns it off; an explicit `continue_final_message` field also exists). Two assistant messages at the end, or an assistant message containing tool calls, are rejected. Prefill is a llama.cpp extension, not standard OpenAI. Whether a continue response returns only the new text was not verified. Reasoning is returned in `reasoning_content`; responses include `usage` and `timings` |
| Native `/completion`   | README: "not OAI-compatible". Prompt as a string, token IDs or a mix. Full sampler set (`temperature`, `top_k`, `top_p`, `min_p`, `typical_p`, repeat and DRY penalties, XTC, `mirostat`, `logit_bias`, `seed`, `stop`, sampler order), `grammar`, `json_schema`, `n_probs`, `return_tokens`, `timings_per_token`. `cache_prompt` defaults to true and can make results nondeterministic. No tools parameter in its option list. Streams over server-sent events with a POST request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/v1/completions`      | OpenAI-shaped raw-prompt endpoint (`choices[].text`). The server copies every body field through to the native parameters, so all sampler settings and `grammar` work; `echo`, `best_of` and `suffix` are rejected. Whether the native-only response extras (`n_probs`, token IDs, timings) appear in its response was not verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/apply-template`      | Turns `messages` into the model's prompt string without running inference. The README says the string can be edited and then sent to `/completion`. A way to continue a chat conversation as raw text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

In router mode, `/completion`, `/v1/completions`, `/v1/chat/completions`, `/apply-template`, `/infill`, `/tokenize` and others are proxied, and the model is chosen by the `model` field in the JSON body; `GET` endpoints use a `model` query parameter. Models auto-load by default (`--no-models-autoload` disables that). Every request from the harness therefore has to name the model. The router also exposes `/models`, `/models/load` and `/models/unload`.

Also present, not evaluated: `/v1/responses` and an Anthropic-style `/v1/messages`. The `/tools` endpoint is documented as internal to the web UI and not for downstream applications.

References: [llama-server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [function-calling doc](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md), [`server-common.cpp`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp), [`server.cpp`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server.cpp), [`server-models.cpp`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-models.cpp), [assistant prefill PR](https://github.com/ggml-org/llama.cpp/pull/13174).

Open question:

- Native `/completion` or `/v1/completions` for raw continuation? Both accept the same sampler settings; they differ in request and response shape.

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

| Option                         | Advantages                                               | Disadvantages                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None in the base               | Nothing to design now                                    | Deferred work                                                                                                                                                       |
| Plain files (JSON or Markdown) | Human-readable; diffable; version-controllable           | No querying                                                                                                                                                         |
| SQLite                         | Queries and indexes; the intended store (R11 assumes it) | Binary file. Node's built-in `node:sqlite` (added in 22.5.0; no flag needed since 22.13.0; still experimental in 22.x) has no encryption options. Encryption is D16 |
| Tauri store plugin             | No backend required                                      | Key-value only; coupled to the app                                                                                                                                  |

R8 (resumable sessions) means sessions must be persisted, so the "None in the base" option no longer fits. R11 refers to a SQLite database, so SQLite is treated as the intended store; what it holds is still open.

Open question:

- What must be persisted (outputs, transcripts, parameter sets, run history), and must it be human-readable?

### D8. Schema and validation library

Decided: Zod (6.15). Story parameters are out of scope for the base. The options researched are kept below. Versions and dates are from the [npm registry](https://registry.npmjs.org/); tests were run in a scratch project against those versions.

| Option                                                 | JSON Schema output                                                                                                             | Standard Schema                         | Fastify                                                                                                                             | Bundle, minified (gzip), one small schema |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Zod 4.6.7 (2026-10-12)                                 | Built in, draft 2020-12. Output mode throws on transforms; refinements dropped silently; integers get ±9007199254740991 bounds | Yes, with `jsonSchema` input and output | Official `@fastify/type-provider-zod` 1.0.3, needs Zod 4.2 or later                                                                 | 454 KB (92 KB); `zod/mini` 17 KB (6 KB)   |
| Valibot 1.5.0 (2026-09-09)                             | Separate `@valibot/to-json-schema` 1.8.0, draft-07. Throws on custom checks unless `errorMode: 'ignore'`                       | Yes, no `jsonSchema`                    | No official provider; `fastify-type-provider-valibot` last published 2024-09-20 for Fastify 4                                       | 4.8 KB (1.7 KB)                           |
| TypeBox 1.4.3 (2026-10-22)                             | The schema object is JSON Schema                                                                                               | No `~standard` found in the test        | Official `@fastify/type-provider-typebox` 6.3.0                                                                                     | 151 KB (39 KB)                            |
| ArkType 2.2.9 (2026-10-20)                             | Built in, draft 2020-12. Morphs and predicates throw unless a `fallback` is given                                              | Yes, with `jsonSchema` input and output | No official provider                                                                                                                | 156 KB (48 KB)                            |
| JSON Schema directly, with `json-schema-to-ts` and Ajv | Is the schema                                                                                                                  | Not applicable                          | Official `@fastify/type-provider-json-schema-to-ts` 5.0.1; Fastify validates with Ajv v8 by default. Registry data only; not tested | Not measured                              |
| Plain TypeScript types                                 | None                                                                                                                           | Not applicable                          | Not applicable                                                                                                                      | None                                      |

Other findings:

- Fastify with Zod, TypeBox, and (through the community package `fastify-standard-schema` 5.0.4) Valibot and ArkType returned 200 for valid and 400 for invalid bodies. That package's README lists Zod, Yup, Joi and Vine as tested.
- `@mantine/form` 9.7.4 has a built-in `schemaResolver` that calls `schema['~standard'].validate`, so it accepts Standard Schema libraries. A TypeBox schema has no `~standard` in the test; the resolver call itself was not tested with it.
- llama.cpp converts only a subset of JSON Schema and skips unsupported features silently ([grammar README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)). Gaps include `properties` mixed with `anyOf` or `oneOf`, `minimum` and `maximum` on non-integers, nested `$ref`s, `patternProperties`, `uniqueItems`, `contains`, `not`, and `if`/`then`/`else`.
- Conversion tests (a representative schema with string limits, an integer range, an enum, an optional array, a nested object and a union):
  - The schemas from Zod, Valibot, TypeBox and ArkType all converted without errors using the converter ported into `llama-cpp-python` 0.3.36 (from PyPI). Zod's and Valibot's grammars were byte-identical; ArkType's and TypeBox's differed only in how the enum is written. Zod schemas with a reused `$ref`, a discriminated union and a string pattern (`^[0-9]{5}$`) also converted.
  - That Python port ignores integer `minimum` and `maximum`. llama.cpp's own C++ converter does not: its `build_min_max_int` function (copied from master into a small standard-library program) produced `([1-9] | "10")` (14 bytes) for 1 to 10.
  - Zod emits ±9007199254740991 bounds on every integer that has no explicit range. For that range the C++ function produced a 5,605-byte rule per field. Valibot, ArkType and TypeBox emit no bounds for an unbounded integer. Giving the Zod integer an explicit `.min()` and `.max()` gives the 14-byte rule. Stripping the default bounds with Zod's `toJSONSchema` `override` option was not tested.
  - Not tested: the full llama-server pipeline (how it parses the bounds from the schema), whether the larger rule slows sampling, and model output quality under any grammar.

- Not researched: schema-to-UI generators. Download counts were unavailable (the npm downloads API is blocked from the session).

Open questions:

- Bound every integer explicitly, or strip Zod's default bounds when generating schemas for llama-server?
- Import full `zod` or `zod/mini`? The two have different APIs. It matters only for the frontend bundle size.

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

R10 (reattach) requires events to have IDs and to be retained, in memory or persisted, so a reconnecting UI can receive what it missed.

Open questions:

- Custom events or an existing protocol?
- Should events be persisted so runs can be replayed or inspected?

### D14. Backend lifetime

R7 says a generation survives a UI reload or close. How long the backend process itself lives determines how far that goes.

| Option                                                              | Advantages                                                           | Disadvantages                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Lives and dies with the desktop app                                 | Simple lifecycle; nothing left running                               | Runs survive a window reload but not quitting the app      |
| Keeps running after the window closes (background or tray)          | Runs survive closing the window                                      | Needs a visible way to stop it; a lifecycle to manage      |
| Independent long-lived service that the app and CLI both connect to | Runs survive quitting the app; one backend serves several front ends | Needs an install and start-up story; multi-client handling |

Sharing a database file between the desktop app and a CLI only needs the same file and the same key. Sharing a live session, with the CLI attaching to a run the desktop app started, needs one harness process serving both, which is the third option. This is desirable but not a requirement for now.

Open questions:

- Which events must a run survive: window reload, window close, app quit?
- If the process is killed mid-generation, must the run resume mid-stream, or is it enough that the session continues from the last completed message?

### D15. Runtime distribution: Node single executable or installed runtime

Status: tabled. R9 stands as written but is under review until this is taken up.

R9 requires self-contained binaries. Node's single executable application (SEA) feature is the built-in way to produce one. Its documented limits ([Node docs](https://nodejs.org/dist/latest/docs/api/single-executable-applications.html)) and their effect on this project:

| SEA limit                                                                                                                                           | Effect on this project                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The entry script must be a single bundle; `require` cannot read from the file system                                                                | Manageable. A bundler produces one file. The earlier prototype was built this way and ran                                                                                                                   |
| Native `.node` addons cannot be loaded from inside the executable; they must be shipped as files and written to a temporary location before loading | Significant if the encrypted SQLite option is a native addon (D16). The addon would be a separate per-platform file, so the result is no longer one file. Whether it works inside a SEA has not been tested |
| A SQLite extension loaded with `loadExtension(path)` is also a per-platform shared library on the real file system                                  | Same effect as a native addon                                                                                                                                                                               |
| `import.meta.resolve` is unsupported; `import()` loads only built-in modules                                                                        | Low risk once everything is bundled. A dependency that uses `import.meta.resolve` would break. This cannot be known until dependencies are chosen                                                           |
| The Node version that builds the blob must match the binary it is injected into                                                                     | Manageable by pinning one Node version in the build                                                                                                                                                         |
| Builds are per platform; code cache and snapshots must be off for cross-platform builds; a known crash on Linux arm64 inside Docker                 | Manageable. Tauri also builds per platform. Matters only for CI design                                                                                                                                      |
| macOS binaries must be re-signed after injection                                                                                                    | Needs checking against Tauri's signing and notarization of external binaries. Not yet verified                                                                                                              |
| The feature is marked "active development" and may change                                                                                           | Moderate. Mitigated by pinning the Node version and re-testing on upgrades                                                                                                                                  |

Options:

| Option                        | Advantages                                                                          | Disadvantages                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. Node SEA, self-contained   | No runtime for users to install; the Tauri app and CLI can each ship as one install | The limits above; native pieces for encryption stay beside the binary; per-platform build and signing pipeline |
| B. Require an installed Node  | None of the SEA limits; native addons install normally with npm                     | Users must install Node; R9 would be dropped; versions are outside our control                                 |
| C. Other Node packaging tools | Possibly different trade-offs                                                       | Not evaluated                                                                                                  |

Open questions:

- A, B or C? A short throwaway test (SEA plus the chosen encrypted SQLite option, on one platform) would answer the main unknown. It is not started.
- Which Node version to target? The prototype used 22; newer releases exist.
- Must the desktop app and the CLI share one binary or be separate? See section 5.

### D16. SQLite driver and encryption (R11)

Decided: `better-sqlite3-multiple-ciphers` in SQLCipher-compatible mode (6.12). License is not a constraint. Stock SQLite does not encrypt, and `node:sqlite` uses Node's bundled SQLite, which has no encryption options. SQLCipher is a build of SQLite that replaces the stock library; it is not a loadable extension. The Node packages found ([comparison article](https://codenote.net/en/posts/electron-encrypted-sqlite-libraries-comparison/), a third-party source):

| Option                            | Encryption engine                                          | Status and caveats                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `better-sqlite3-multiple-ciphers` | SQLite3 Multiple Ciphers, with a SQLCipher-compatible mode | MIT. Active. N-API, so one binary covers many Node versions. Prebuilds for mainstream platforms. The default cipher is not SQLCipher's; the SQLCipher mode needs extra PRAGMAs and the key set before use |
| `@journeyapps/sqlcipher`          | Upstream SQLCipher with OpenSSL, on a fork of node-sqlite3 | v6.0.0 (April 2026) dropped Windows and prebuilt binaries: source builds only, on macOS and Linux                                                                                                         |
| `@signalapp/sqlcipher`            | Upstream SQLCipher 4.10.0                                  | N-API. Prebuilds oriented to Signal's own targets                                                                                                                                                         |
| SQLite Encryption Extension (SEE) | The SQLite team's commercial encryption                    | US$2,000 perpetual license. No prebuilds; built from the amalgamation                                                                                                                                     |

It is a native addon, so it interacts with D15 (tabled).

The library sets the SQLCipher mode with settings applied before the key each time the database is opened (`cipher='sqlcipher'` and `legacy=4`, per its README).

Checked against the package and a round-trip test (driver 13.0.3 on Linux x64, Node 22; sources: [npm registry](https://registry.npmjs.org/better-sqlite3-multiple-ciphers), SQLite3 Multiple Ciphers source):

- Latest version 13.0.3, published 2026-08-07. MIT. Requires Node 22 or newer. Native addon built on `node-addon-api`.
- Prebuilt binaries are shipped inside the npm package for: Windows x64 and arm64; Linux (glibc) x64 and arm64; Linux (musl) x64 and arm64; macOS x64 and arm64.
- With `cipher='sqlcipher'` and `legacy=4`, the settings are PBKDF2-HMAC-SHA512, 256,000 iterations, HMAC-SHA512 and a 4096-byte page size, the same as the SQLCipher 4.0 defaults ([SQLCipher 4.0.0 release post](https://www.zetetic.net/blog/2018/11/30/sqlcipher-400-release/)).
- A database created by the driver opened in stock SQLCipher 4.5.6, and a database created by stock SQLCipher 4.5.6 opened in the driver. A wrong key or no key fails with "file is not a database".
- The key can be a passphrase (run through the KDF) or a raw key written `x'` plus 64 hex digits (no KDF); both worked in both tools. The `key(Buffer)` method gave the same result as the `key` pragma with the same passphrase. In the pragma form, a single quote in a passphrase has to be doubled.
- Not tested: SQLCipher 4.5.7 (the version Chitter uses), a real Chitter database file, or any platform other than Linux x64.

Prior art: Chitter (kyleect/chitter, Rust) uses SQLCipher 4.5.7 through `libsqlite3-sys` 0.30.1 with `bundled-sqlcipher`, and sets the key with a `key` pragma on connect. See D17 for how it handles migrations.

Open question:

- Which platforms must have working prebuilt binaries (D11)? The package ships the eight listed above.

### D17. Migrations and query layer (6.11)

Migrations must run inside the shipped application, so an in-process tool is the natural fit. Findings:

| Option                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-written runner                     | A small runner that applies numbered `.sql` files and records the schema version with SQLite's `user_version` pragma. No dependency; maintained in this project                                                                                                                                                                                                                                                                                                     |
| `@blackglory/better-sqlite3-migrations` | Written for better-sqlite3 and records the version with `user_version`. Each migration has `up` and `down`, as a SQL string or a function ([npm](https://npmjs.com/package/@blackglory/better-sqlite3-migrations)). Version, publish date and maintenance were not shown on the page. Compatibility with the multiple-ciphers fork has not been tested                                                                                                              |
| Kysely migrator                         | Kysely is a typed query builder, not an ORM, with a built-in migrator whose migrations are TypeScript or JavaScript functions that can run raw SQL. From general knowledge; not verified here. A file-based provider reads migrations from the file system, which conflicts with single-file bundling, so migrations would be supplied from the bundle                                                                                                              |
| Umzug                                   | Migration runner that is not tied to a database; migrations and storage are supplied by the application. From general knowledge; not verified here                                                                                                                                                                                                                                                                                                                  |
| Postgrator                              | Ruled out: its documented databases are Postgres, MySQL and SQL Server, not SQLite ([npm](https://www.npmjs.com/package/postgrator))                                                                                                                                                                                                                                                                                                                                |
| dbmate, Atlas                           | Single binaries with plain SQL files; separate programs to ship ([comparison](https://www.pkgpulse.com/guides/drizzle-kit-vs-atlas-vs-dbmate-schema-migration-tools-2026))                                                                                                                                                                                                                                                                                          |
| Flyway                                  | Supports SQLite; its command line bundles a Java runtime ([requirements](https://documentation.red-gate.com/flyway/getting-started-with-flyway/system-requirements/command-line-and-api-requirements))                                                                                                                                                                                                                                                              |
| Drizzle Kit                             | Part of an ORM, which 6.11 excludes                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| sqlx-cli (development only)             | Rust tool; plain `.sql` files; stores a checksum per applied migration and `run` stops if an applied file changed; reversible migrations are optional; no repair command found ([0.9.0 source](https://docs.rs/crate/sqlx-cli/0.9.0/source/src/migrate.rs)). It would author and check migrations against an unencrypted development database. It does not run inside the TypeScript harness, so a separate runner would still be needed for the encrypted database |

Reference: how Chitter (kyleect/chitter, Rust) does it, read from its public files:

- Dependencies: `sqlx` 0.8 with the `sqlite` feature, and `libsqlite3-sys` 0.30.1 with `bundled-sqlcipher` ([`server/Cargo.toml`](https://github.com/kyleect/chitter/blob/main/server/Cargo.toml)).
- Key: set with `.pragma("key", ...)` on `SqliteConnectOptions`, with an optional `rekey` pragma to rotate it ([`server/src/db.rs`](https://github.com/kyleect/chitter/blob/main/server/src/db.rs)).
- sqlx-cli is used only against an unencrypted development database (`sqlite://db.sqlite3`): create database, add migration (reversible), run, revert, prepare ([`justfile`](https://github.com/kyleect/chitter/blob/main/justfile)). It never touches the encrypted database, so SQLCipher compatibility of the CLI does not arise.
- The running app embeds the migrations with `sqlx::migrate!()` and applies them to the encrypted database when it connects.
- Embedding with `migrate!()` is a Rust library feature and is not available to a TypeScript harness.

Stated requirements:

- Queries are raw SQL through the driver; no query builder.
- Migrations are plain `.sql` files, not TypeScript.
- Each applied migration's checksum is stored, and a changed file is detected.
- Down (reversible) migrations are not required.
- Migrations are expected to run during development. Stated: not wanted on a shipped app. What happens when a shipped app finds a database older than its schema is not yet settled.

Still open:

- Which migration tool, or a hand-written runner. A hand-written runner would have to implement file ordering, the history table, checksum checks, failure handling, concurrent starts (a CLI and the desktop app on one database) and baselining. No Node tool found so far combines plain SQL files, SQLite and checksums.
- Behavior when a stored checksum does not match: refuse to run, and whether an explicit repair command exists.
- Embedding the migrations in the bundle, or shipping them as files. Depends on D15.
- Behavior on a shipped app whose database is behind the schema (automatic, explicit command only, or none yet).

### D18. Encryption key management (R11)

Decided: environment variable (6.13). Threat model: anyone who acquires the database file must not be able to read it. The key therefore has to live somewhere other than the database file and anything copied with it.

| Option                                                                                                   | Holds up when                                                                                                        | Does not hold up when                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Random key in the OS credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service) | The database file is copied; also a stolen disk, since these stores are encrypted under the user's login credentials | Malware runs as the user                                                                                                                                                                               | No prompt, so unattended runs work (R7). A CLI can read the same entry by name and so open the same database; on macOS a different binary's first access normally prompts the user. Needs a native piece (for example `@napi-rs/keyring`, a keytar replacement shipping prebuilt binaries; the page checked only described Linux) or the Tauri layer. Headless Linux may have no Secret Service. Behavior stated from general knowledge; to be verified |
| User passphrase                                                                                          | The database file is copied; the key exists only in the user's head                                                  | The passphrase is weak or forgotten                                                                                                                                                                    | A prompt on every launch; a lost passphrase means lost data; does not fit unattended runs                                                                                                                                                                                                                                                                                                                                                               |
| Key in an environment variable                                                                           | The database file alone is copied                                                                                    | The home directory or a disk image is copied, if the variable is set in a plain-text file such as `.bashrc`: any process running as that user can read that file, as can anyone holding a backup of it | Better than a command-line argument, which other users can see in process listings. A running process's environment is readable by other processes of the same user (on Linux, through `/proc`)                                                                                                                                                                                                                                                         |
| Key in a file with owner-only permissions                                                                | The database file alone is copied                                                                                    | The home directory or a disk image is copied                                                                                                                                                           | Same exposure as `.bashrc`, but kept out of shell startup files; can be placed outside synced or backed-up folders                                                                                                                                                                                                                                                                                                                                      |

Open questions:

- What is the variable called?
- What happens on first run, when no database exists: does the user supply a key, or does the harness generate one and show it once?
- What happens if the variable is missing: refuse to start, or prompt?
- Must it work unattended and in CI? (An environment variable does.)
- What does the variable hold: a passphrase, or a raw 64-digit hex key? A passphrase runs the 256,000-iteration KDF each time the database is opened.
- Is key rotation needed? The driver supports it with `rekey`; Chitter supports it.

## 8. Future work

- **Continue in a new session.** An alternative to context compaction: a new session can selectively search prior sessions rather than loading them fully into context.
- **CLI attaching to a live desktop session.** Desirable; not required for now. Depends on D14.
- **Additional model servers.** Other OpenAI-compatible servers beyond llama.cpp.
- **Story layer.** Parameters, constraints, story structure and story-specific agents, in a separate design.
