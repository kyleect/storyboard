# AGENTS.md: `@harness/tools`

Every tool an agent can call, plus the prompt text that describes some of them.
Read the root `AGENTS.md` first. Background: `docs/tools.md`.

## Hard rules

- **Tools never touch the database or the file system directly.** They act only
  through the interfaces on `ToolContext` (`ctx.entries`, `ctx.data`,
  `ctx.projects`, `ctx.agents`, `ctx.subagents`, `ctx.skills`, `ctx.requestInput`,
  and the workspace access), which the backend implements. Do not import
  `better-sqlite3`, `fastify` or anything from `@harness/backend` here.
- Depends only on `@harness/core` (plus `zod`, `turndown`, `@mixmark-io/domino`).
- The frontend does not import this package.

## Adding or changing a tool

1. Build it with `defineTool` from `@harness/core`. Put it in the file for its
   topic (see below) and register it in `allTools` in `src/index.ts`, through
   the file's exported list if there is one (for example `entryTools`).
2. Every tool declares:
   - `name` (snake_case), `description` (this is prompt text the model reads;
     write it for the model),
   - `input`: a Zod object,
   - `approval`: `"never"`, `"ask"` or `"always"`,
   - `group`: one of `TOOL_GROUPS` in core. Each tool is in exactly one group.
3. Optional: `alwaysOn`, `needsReview` (destructive or prompt-changing tools; a
   group grant does not cover them), `available(run)`, and `review` (to describe
   changes before approval).
4. Return `{ data }` for success. Report expected failures as results, not
   thrown errors: use `fail(message, reason, target)`, `guarded(...)` and
   `notDone(...)` from `results.ts`. Throw `ToolError` only for unexpected
   failures.
5. A tool may call `ctx.requestInput(form)` at most once per call (the run waits
   for the user to answer or skip). The file and copy tools use it so the model
   suggests and the user decides.
6. Add a test beside it. `clock.test.ts` shows how to build a `ToolContext` by
   hand; `index.test.ts` checks the registry.
7. Update the tool tables in `docs/tools.md`.

The `description` and `input` shapes are sent to the model as the tool
definition, so renaming a tool or a field changes what existing agents and
saved transcripts see. Do not rename without a reason.

## Layout

```
src/
  index.ts           allTools, and re-exports
  clock.ts           current_date, current_time
  web.ts             web_search, read_webpage, read_wiki
  ask-user.ts        ask_user
  entries.ts         file and memory tools, entriesInstruction
  copy.ts            files_copy/move, memory_copy/move
  projects.ts        projects_list, project_view, project_create
  project-copy.ts    what project_create copies
  agents.ts          agents_list, agent_view
  subagents.ts       start_subagent, subagent_handback
  skills.ts          skill_load, skillsList, skillsInstruction
  schemas-data.ts    schema and data tools, schemasText, dataText, schemasInstruction
  workspaces.ts      workspace tools
  results.ts         shared helpers: fail, notDone, guarded
  domino.d.ts        type declaration for @mixmark-io/domino
```

## Testing

Tests run in the Vitest `node` project. Do not make real network calls from
`web.ts` tests; stub `fetch`.

## Build

`pnpm build:tools` (`tsc -b packages/tools`, which also builds core). The
backend's `dev:backend` script runs it first because the backend's dev run uses
the built output.
