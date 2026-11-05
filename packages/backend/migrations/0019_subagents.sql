-- Subagents (agent delegation design). A child run is a run of its own with
-- a parent: the run whose `start_subagent` call started it, and that call's
-- id. NULL: a top-level run.
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN parent_call_id TEXT;

-- Per-agent settings, saved with each version. `child_reminders` and
-- `child_prompt` are NULL when the agent does not set them (the global
-- setting applies); an empty `child_prompt` means no child line. `subagent`
-- marks an agent that can be started as a subagent (opt-in).
ALTER TABLE agents ADD COLUMN child_reminders INTEGER;
ALTER TABLE agents ADD COLUMN child_prompt TEXT;
ALTER TABLE agents ADD COLUMN subagent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_versions ADD COLUMN child_reminders INTEGER;
ALTER TABLE agent_versions ADD COLUMN child_prompt TEXT;
ALTER TABLE agent_versions ADD COLUMN subagent INTEGER NOT NULL DEFAULT 0;
