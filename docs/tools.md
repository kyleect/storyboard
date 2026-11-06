# Tools (`@harness/tools`)

This package contains every tool an agent can call, plus the prompt text that
describes some of them. Each tool is built with `defineTool` from core (see
[core.md](core.md#tools-api)) and is registered in one list, `allTools`, which
the backend passes to the run manager.

Tools are the only way an agent affects anything outside the conversation. They
never touch the database. They act through the interfaces on `ToolContext`
(`ctx.entries`, `ctx.data`, `ctx.projects`, `ctx.agents`, `ctx.subagents`,
`ctx.skills`, `ctx.requestInput`), which the backend implements.

```
packages/tools/src
  index.ts           allTools, and re-exports
  clock.ts           current_date, current_time
  web.ts             web_search, read_webpage, read_wiki
  ask-user.ts        ask_user
  entries.ts         file and memory tools, entriesInstruction
  copy.ts            files_copy/move, memory_copy/move
  projects.ts        projects_list, project_view, project_create
  agents.ts          agents_list, agent_view
  subagents.ts       start_subagent, subagent_handback
  skills.ts          skill_load, skillsList, skillsInstruction
  schemas-data.ts    schema and data tools, schemasText, dataText, schemasInstruction
  results.ts         shared helpers: fail, notDone, guarded
```

## How a tool call is handled

For every call the loop validates the arguments, optionally asks the user for
approval, runs `execute`, and stores the result (see
[core.md](core.md#running-one-tool-call-runcall)). A tool author decides only:

- the input schema (Zod);
- the **approval default**: `ask`, `never` or `always`;
- what `execute` returns: `{ data }` for success, `{ data, isError: true,
  details }` for a failure the model should see, or a thrown `ToolError`;
- optionally `review`, to describe changes before they are approved.

**Error results.** Tools report expected failures as results, not exceptions.
`results.ts` provides `fail(message, reason, target)`, which returns an error
result with `details.reason` of `not_found` or `rejected`. `guarded(...)`
converts an `EntryError` thrown by core into such a result. `notDone(text)`
returns an error result for "the user skipped the form" that the loop does not
count as an error.

**Asking the user mid-call.** A tool may call `ctx.requestInput(form)` once per
call. The run pauses until the user answers or skips. The file and copy tools
use this to let the user fill in or correct what the model suggested.

## The tools

Approval column: **never** runs without asking, **ask** asks unless the user
has changed the setting, **always** asks every call and cannot be changed.
Users can change `ask` and `never` per tool in Settings, per agent in the
agent's page, and per session by choosing *Allow for this session*.

### General

| Tool | Approval | What it does |
| --- | --- | --- |
| `current_date` | never | Today's date (`YYYY-MM-DD`) and time zone, where the backend runs. |
| `current_time` | never | The current time (`HH:MM:SS`) and time zone. |
| `web_search` | never | Searches DuckDuckGo Lite and returns results as short Markdown lines. Reports a bot check or an unreadable page as an error. |
| `read_webpage` | never | Fetches a URL and returns it as Markdown. `<style>`, `<script>`, `<noscript>` and images are removed first. |
| `read_wiki` | never | Fetches an English Wikipedia article by topic and returns Markdown. |
| `ask_user` | never | Shows the user a form built from a JSON Schema and returns the answers, or an error saying the user declined. See [core.md](core.md#input-forms-formsts). |

### Files and memory

Files are named documents; memory notes are short notes the model writes for
itself. Both live in the **session**, **project** or **global** scope. One tool
exists per operation. None asks for approval by default, but several show a
form, because *the model suggests and the user decides* where things go.

| Tool | Approval | What it does |
| --- | --- | --- |
| `files_list` | never | Lists files (key, type, size, scope). Covers every scope unless narrowed; when the model narrows scopes the user confirms. |
| `files_read` | never | Reads one file by key. If the key exists in several scopes, the user picks. |
| `files_write` | never | Creates or replaces a file. For a new file, a form asks for the name and scope with the model's suggestions filled in. |
| `files_delete` | never | Deletes a file by key. History is kept and the user can restore it. |
| `files_search` | never | Keyword and meaning search over files; returns the best matches with excerpts. |
| `memory_list` | never | Lists notes (id, text, scope). |
| `memory_add` | never | Saves a note; the user chooses where. Returns the id and scope. |
| `memory_update` | never | Replaces a note's text by id. |
| `memory_delete` | never | Deletes a note by id. |
| `memory_search` | never | Keyword and meaning search over notes. |

Key rules: letters, digits, `.`, `_` and `-` only; case-sensitive. File types
are `plain`, `markdown` and `json` (a `json` file must parse).

The **copy and move** tools move entries between scopes or to another project.
They always ask for approval and then show a form with the model's suggested
source and destination preselected. They warn when the destination already has
a file with that key, and skip keys that already exist there.

| Tool | Approval | What it does |
| --- | --- | --- |
| `files_copy` / `files_move` | always | Copy or move files to another scope or project. A move deletes the originals only for what was copied. |
| `memory_copy` / `memory_move` | always | The same for notes. Each copy gets a new id. |

A call may name at most `copyLimit` keys (setting, maximum 200) unless it asks
for everything in a scope. Entries can be sent to a *different* project only
from the session or project scope, and through a write-only handle: nothing in
another project can be read.

`entriesInstruction(inProject)` produces the fixed system-message paragraph that
explains files, memory, scopes and the copy tools to the model, ending with
whether the session is in a project.

### Projects and agents

| Tool | Approval | What it does |
| --- | --- | --- |
| `projects_list` | never | Lists projects not in the trash (id, name, description). |
| `project_view` | always | Shows the session's project: name, description, default agent, system prompt. |
| `project_create` | always | Creates a project from the session. The user edits the name, description and system prompt in a form and chooses whether the session's files and notes are copied in. |
| `agents_list` | never | Lists the agents the session can pick (project agents first, then global), including tool selection and whether each can be started as a subagent. |
| `agent_view` | always | Shows the agent this run is using, including its system prompt. |

### Subagents

| Tool | Approval | What it does |
| --- | --- | --- |
| `start_subagent` | ask | Starts another agent (one with `subagent: true`) on a task and waits for its result. The agent sees only the task text, not the conversation. |
| `subagent_handback` | never | Ends a subagent's run and returns its output to the agent that started it. Offered only in child runs. |

`start_subagent` is not offered once the depth limit is reached. If the agent id
is unknown or not startable, the call fails with a message that points the model
back to `agents_list`. If the child ends without handing back, the parent gets an
error result with the reason (`failed`, `cancelled`, `iteration_limit` or
`no_output`) and the child's last text if it wrote any. See
[backend.md](backend.md#subagents).

### Skills

| Tool | Approval | What it does |
| --- | --- | --- |
| `skill_load` | never | Returns the full instructions of one listed skill by name. If two skills share a name, the model must also give the scope. |

`skill_load` is offered only when at least one skill is in scope.
`skillsList(skills)` renders the list (`- name: description`, with the scope
shown only for names that exist in more than one scope) and
`skillsInstruction(skills)` wraps it with an introduction.

### Schemas and data

Reads never ask; writes ask by default.

| Tool | Approval | What it does |
| --- | --- | --- |
| `schemas_list` | never | Lists available schemas (id, name, scope, description, latest version). |
| `schema_view` | never | Shows a schema and its JSON Schema (latest or an earlier version). |
| `schema_create` | ask | Creates a schema in a scope. |
| `schema_update` | ask | Changes name, description or JSON Schema. Only a JSON Schema change adds a version. Data that passes the new version moves to it; data that does not stays and is "out of date". |
| `schema_copy` | ask | Copies a schema's latest version into a scope as version 1 of a new schema (for example, to change a built-in). |
| `schema_delete` | ask | Deletes a schema and its data together. Restorable. |
| `data_list` | never | Lists data without values. |
| `data_view` | never | Shows a piece of data with its value, its schema version and any out-of-date warning. |
| `data_create` | ask | Creates data from a schema's latest version. The value must match. |
| `data_update` | ask | Changes data with a JSON merge patch, and/or its name and description. Stays on its schema version. |
| `data_migrate` | ask | Moves one piece of data to a newer schema version: defaults first, then the patch. |
| `data_migrate_many` | ask | Migrates several pieces in one call; each succeeds or fails alone. |
| `data_delete` | ask | Deletes data. Restorable. |

The write tools declare `review`. Before the approval prompt is shown, the tool
computes exactly what would change (a **plan**), and the prompt displays each
item with its field-level changes. The user may approve only some of the changes;
the tool's `execute` receives that selection through `ctx.approval` and applies
only what was approved. If the data changed after the prompt was shown, the user
must refresh the changes or deny the call.

Because the tools use `ctx.data`, a write in the **session** scope is recorded on
the tool result as `dataOps`, while writes to other scopes go straight to the
backend's tables.

`schemasText`, `dataText` and `schemasInstruction` produce the lists and
instruction text placed in the system message.

## Where each tool becomes available

All tools are registered in `allTools`. The backend then narrows the list per
run (see [backend.md](backend.md#which-tools-a-run-gets)):

- Skill tools are dropped unless a skill is in scope.
- `subagent_handback` is offered only in child runs.
- `start_subagent` is dropped at the subagent depth limit.
- If the session's agent has a tool selection, only those tools remain, plus the
  **always-on** tools: the file and memory tools (`files_*` except copy/move,
  `memory_*` except copy/move), `skill_load`, and `subagent_handback`.

## Writing a new tool

1. Create the tool with `defineTool` in a module in `packages/tools/src` and
   give every integer field `.min()` and `.max()`.
2. Choose its approval default. Use `always` only for tools that must never be
   allowed silently.
3. Use `ctx` interfaces for anything stateful. If the tool needs a capability
   that does not exist yet, add an interface to `ToolContext` in core and
   implement it in the backend.
4. Return failures with `fail(...)` or `isError: true` so the model can recover.
5. Add the tool to `allTools` in `index.ts`.
6. If every agent should have it regardless of selection, add it to the backend's
   `alwaysOnTools` in `main.ts`.
