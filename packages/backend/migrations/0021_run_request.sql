-- What a run sent to the model, for debugging. `system_prompt` is the fully
-- composed system message (global, project and agent prompts with their
-- placeholders filled in, the skill and schema lists, the files and memory
-- instruction, a subagent's line). `tools` is the JSON list of tool
-- definitions the run offered. Both are NULL for runs made before this
-- migration, whose prompts were not kept.
ALTER TABLE runs ADD COLUMN system_prompt TEXT;
ALTER TABLE runs ADD COLUMN tools TEXT;
