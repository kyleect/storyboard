-- Per-agent approval settings for tools (agent tool approval design, Q1, Q6).
-- A JSON object: tool name -> true (ask before each call) or false (don't
-- ask). A tool with no entry follows its own setting. Saved with each
-- version, so a restored version brings its settings back.
ALTER TABLE agents ADD COLUMN tool_approval TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_versions ADD COLUMN tool_approval TEXT NOT NULL DEFAULT '{}';
