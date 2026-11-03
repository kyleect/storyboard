-- Skills (skills design). A skill is global (no project, no agent), a
-- project's (project_id) or an agent's (agent_id); never both.

CREATE TABLE skills (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),
  agent_id     TEXT REFERENCES agents(id),
  display_name TEXT NOT NULL,
  -- The slug made from display_name (decisions 4, 5); the name the model uses.
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  version      INTEGER NOT NULL, -- seq of the current version
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT, -- NULL: not deleted. Deleted skills can be restored.
  CHECK (project_id IS NULL OR agent_id IS NULL)
);
-- Unique per scope; a deleted skill keeps its name (decision 3).
CREATE UNIQUE INDEX skills_name
  ON skills(coalesce(project_id, ''), coalesce(agent_id, ''), name);
CREATE INDEX skills_project ON skills(project_id);
CREATE INDEX skills_agent ON skills(agent_id);

-- Every state a skill has had, oldest first, including the current one
-- (decision 16). A delete is a version with deleted = 1 and the last content.
CREATE TABLE skill_versions (
  skill_id     TEXT NOT NULL REFERENCES skills(id),
  seq          INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (skill_id, seq)
);
