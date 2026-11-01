-- Agents (agents design; plan 1.1). Global agents have no project.

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id), -- NULL: global
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', -- empty when there is none
  prompt      TEXT NOT NULL,
  -- 'allow': only the listed tools; 'deny': every tool but the listed ones
  -- (decision 6). The files and memory tools are always on (decision 8).
  tool_mode   TEXT NOT NULL CHECK (tool_mode IN ('allow', 'deny')),
  tools       TEXT NOT NULL, -- JSON array of tool names (P2)
  version     INTEGER NOT NULL, -- seq of the current version
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT -- NULL: not deleted. Deleted agents can be restored.
);
-- Unique per scope, case-sensitive; a deleted agent keeps its name
-- (decision 4).
CREATE UNIQUE INDEX agents_name ON agents(coalesce(project_id, ''), name);
CREATE INDEX agents_project ON agents(project_id);

-- Every state an agent has had, oldest first, including the current one
-- (decision 20). A delete is a version with deleted = 1 and the last
-- content (P9).
CREATE TABLE agent_versions (
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  tool_mode   TEXT NOT NULL CHECK (tool_mode IN ('allow', 'deny')),
  tools       TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);

-- The session's chosen agent. NULL: no agent (decisions 10 to 12).
ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);

-- The agent and version each run used, and, for assistant messages, those
-- of the run that last wrote the message (decisions 13, 14). NULL: none.
ALTER TABLE runs ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE runs ADD COLUMN agent_version INTEGER;
ALTER TABLE messages ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE messages ADD COLUMN agent_version INTEGER;
