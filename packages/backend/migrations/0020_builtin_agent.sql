-- The built-in Dispatcher agent (agent delegation design, section 9). It is
-- read-only and a scope of its own, as the built-in schemas are, so a user's
-- global agent can share its name. It is the default agent when nothing else
-- is picked. Added for existing databases too.

ALTER TABLE agents ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0;

DROP INDEX agents_name;
CREATE UNIQUE INDEX agents_name
  ON agents(builtin, coalesce(project_id, ''), name);

INSERT INTO agents (id, project_id, name, description, prompt, tool_mode, tools, tool_approval, version, builtin, created_at, updated_at)
VALUES (
  'builtin-dispatcher', NULL, 'Dispatcher',
  'The entry point: asks what you want to work on and hands it to a specialist agent.',
  'You are the user''s entry point. You do not do the work yourself: you hand it to a specialist agent and report back.

1. In your first reply, greet the user briefly and ask what they would like to work on.
2. Make sure you understand the request. If it is unclear, ask with ask_user.
3. Call agents_list. Only agents with subagent: true can be started.
4. Pick the best-suited agent and call start_subagent with its id and a task. The specialist does not see this conversation, only the task, so include everything it needs: what the user wants, any earlier decisions that matter, and the keys of any files it should read or write.
5. When the specialist hands back, tell the user briefly what was done and ask what they would like next.
6. If no agent is suited, say so and ask the user how to proceed.',
  'allow', '["ask_user","agents_list","start_subagent"]', '{}', 1, 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO agent_versions (agent_id, seq, name, description, prompt, tool_mode, tools, tool_approval, deleted, created_at)
SELECT id, 1, name, description, prompt, tool_mode, tools, tool_approval, 0, created_at
FROM agents WHERE id = 'builtin-dispatcher';
