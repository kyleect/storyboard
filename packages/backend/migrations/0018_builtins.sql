-- Built-in schemas and skills (schemas and data design, decisions 45 to 52;
-- plan P6, P7). They are read-only and a scope of their own, so a user's
-- global schema or skill can share a built-in's name. Added for existing
-- databases too (decision 45). What happens when a later release changes a
-- built-in is not decided yet (design, section 7).

ALTER TABLE schemas ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;

DROP INDEX schemas_name;
CREATE UNIQUE INDEX schemas_name
  ON schemas(builtin, coalesce(project_id, ''), coalesce(agent_id, ''), name);
DROP INDEX skills_name;
CREATE UNIQUE INDEX skills_name
  ON skills(builtin, coalesce(project_id, ''), coalesce(agent_id, ''), name);

-- ---- Schemas (decisions 47 to 49) -------------------------------------------

INSERT INTO schemas (id, name, description, version, builtin, created_at, updated_at)
VALUES
  ('builtin-task', 'Task',
   'A piece of work to do, with its status: todo, in progress, done, blocked (with what it waits on) or paused.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-goal', 'Goal',
   'An outcome being worked toward, with its status and how to tell when it is met.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-decision', 'Decision',
   'Something settled with the user: the question, the choice made and the reason for it.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO schema_versions (schema_id, version, body, created_at)
VALUES
  ('builtin-task', 1, json('{
    "type": "object",
    "properties": {
      "title": { "type": "string", "title": "Title", "minLength": 1 },
      "status": {
        "type": "string",
        "title": "Status",
        "enum": ["todo", "in_progress", "done", "blocked", "paused"],
        "default": "todo"
      },
      "blockedBy": {
        "type": "string",
        "title": "Blocked by",
        "description": "What it waits on, when blocked."
      },
      "notes": { "type": "string", "title": "Notes" }
    },
    "required": ["title", "status"]
  }'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-goal', 1, json('{
    "type": "object",
    "properties": {
      "goal": { "type": "string", "title": "Goal", "minLength": 1 },
      "status": {
        "type": "string",
        "title": "Status",
        "enum": ["active", "blocked", "paused", "achieved", "dropped"],
        "default": "active"
      },
      "blockedBy": {
        "type": "string",
        "title": "Blocked by",
        "description": "What it waits on, when blocked."
      },
      "doneWhen": {
        "type": "string",
        "title": "Done when",
        "description": "How to tell the goal is met."
      }
    },
    "required": ["goal", "status"]
  }'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-decision', 1, json('{
    "type": "object",
    "properties": {
      "question": { "type": "string", "title": "Question", "minLength": 1 },
      "choice": { "type": "string", "title": "Choice", "minLength": 1 },
      "reason": { "type": "string", "title": "Reason", "minLength": 1 }
    },
    "required": ["question", "choice", "reason"]
  }'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---- Skills (decisions 51, 52) ------------------------------------------------

INSERT INTO skills (id, display_name, name, description, body, version, builtin, created_at, updated_at)
VALUES
  ('builtin-schemas-and-data', 'Schemas and data', 'schemas-and-data',
   'Use whenever you keep or change structured state with the schema and data tools: which tool to use, where data goes, how changes are written, and what to do with out-of-date data.',
   '# Schemas and data

Data is structured state you and the user keep track of, made from a schema. Use it for state that changes as the work goes on. Use files for writing kept for the user, and memory notes for loose facts.

## Before you act
- Call data_list to see what exists before creating anything. It shows names and descriptions only; open what matters with data_view.
- Use an existing schema when one fits (schemas_list). Make a new schema only when none does.

## Where data goes
- session: only this conversation; it rewinds when the conversation is edited or a reply is regenerated.
- project: every conversation in this project.
- agent: every conversation with this agent.
- global: every conversation.
Pick the narrowest scope the state is needed in. Data lives in its schema''s scope or a narrower one.

## Writing changes
- data_update takes a merge patch: send only the fields that change. A field set to null is removed. Lists are replaced whole, so send the full new list.
- Changes ask the user first. The user can approve some fields and reject others. Respect what was rejected; do not propose it again unless the user asks.

## Out-of-date data
- When a schema gets a new version, data that does not fit it is out of date, with the problems listed.
- Fix it with data_migrate, or data_migrate_many for several at once. The new version''s defaults are filled in first.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-tasks', 'Tasks', 'tasks',
   'Use when work has several steps: track them as Task data and keep their status current.',
   '# Tasks

Track multi-step work as data made from the built-in Task schema.

- Break the work into tasks when it has more than a couple of steps. Each task is one thing that can be finished.
- Keep one task in_progress at a time. Mark it done as soon as it is finished, not at the end.
- When a task cannot go on, mark it blocked and say what it waits on in blockedBy (for example "the user''s answer about the ending"). Ask for that instead of guessing past it.
- Mark a task paused when the user sets it aside for now; it is expected to resume.
- Use notes for what someone picking the task up needs to know.
- Check the tasks with data_list before starting new work, so you continue rather than duplicate.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-goals', 'Goals', 'goals',
   'Use at the start of a piece of work and while doing it: set a Goal, steer by it, and decide when it is met.',
   '# Goals

Keep what the work is for as data made from the built-in Goal schema.

- At the start of a piece of work, propose a goal from what the user asked, with doneWhen saying how you will know it is met. The user approves or adjusts it; this is where misunderstandings surface early.
- Check active goals before planning tasks, so the tasks serve them. While working, compare what you produce against the goal.
- When doneWhen is met, propose marking the goal achieved instead of continuing to polish.
- When the goal cannot go on, mark it blocked with what it waits on in blockedBy, and ask for it.
- paused means set aside for now and expected to resume: do not work on it and do not propose dropping it.
- dropped means abandoned on purpose: keep it, and do not revive it unless the user asks.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('builtin-decisions', 'Decisions', 'decisions',
   'Use when the user and you settle something, and before writing anything a past decision may cover.',
   '# Decisions

Record what is settled with the user as data made from the built-in Decision schema: the question, the choice and the reason.

- When something is settled (the tense, a character''s age, whether someone survives), record it as a Decision.
- Before writing, check the decisions that may cover what you are about to write, and follow them.
- The reason says why the choice was made. Use it to judge whether a new situation is an exception; do not apply a decision blindly where its reason does not hold.
- When a decision needs to change, propose an update to it, with the new reason. Do not quietly contradict it.
- Scope a decision about the whole story to the project, and one about a single draft to the session.',
   1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO skill_versions (skill_id, seq, display_name, name, description, body, created_at)
SELECT id, 1, display_name, name, description, body, created_at
FROM skills WHERE builtin = 1;
