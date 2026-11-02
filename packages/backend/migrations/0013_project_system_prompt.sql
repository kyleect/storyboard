-- A project's system prompt (system prompts design, decision 4): sent after
-- the global prompt and before the agent's. Empty: none.

ALTER TABLE projects ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
