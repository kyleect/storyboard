-- The agent a new session in the project starts with (default agent design,
-- decisions 1 and 7). NULL: none. A project's own agent or a global one.
ALTER TABLE projects ADD COLUMN default_agent_id TEXT REFERENCES agents(id);
