-- Schemas and data (schemas and data design). Global (no project, no
-- agent), a project's or an agent's; never both. Session schemas and data
-- have no table: they are rebuilt from the transcript (decision 4).

CREATE TABLE schemas (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id),
  agent_id    TEXT REFERENCES agents(id),
  name        TEXT NOT NULL, -- at most 64 characters (decision 8a)
  description TEXT NOT NULL, -- at most 1,024 characters
  version     INTEGER NOT NULL, -- the latest version (decision 10)
  copied_from TEXT, -- the schema this was copied from (decision 12)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- NULL: not deleted. A deleted schema hides its data (decision 14).
  deleted_at  TEXT,
  CHECK (project_id IS NULL OR agent_id IS NULL)
);
-- Unique per scope (decision 9); a deleted schema keeps its name.
CREATE UNIQUE INDEX schemas_name
  ON schemas(coalesce(project_id, ''), coalesce(agent_id, ''), name);
CREATE INDEX schemas_project ON schemas(project_id);
CREATE INDEX schemas_agent ON schemas(agent_id);

-- One JSON Schema per version (decision 10). Renames don't add one.
CREATE TABLE schema_versions (
  schema_id  TEXT NOT NULL REFERENCES schemas(id),
  version    INTEGER NOT NULL,
  body       TEXT NOT NULL, -- the JSON Schema, as JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (schema_id, version)
);

-- A piece of data (decisions 22 to 25), in the same scopes as schemas.
CREATE TABLE data (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id),
  agent_id       TEXT REFERENCES agents(id),
  schema_id      TEXT NOT NULL REFERENCES schemas(id),
  schema_version INTEGER NOT NULL, -- the pinned version (decision 6)
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  value          TEXT NOT NULL, -- JSON; for deleted data, its last value
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT, -- NULL: not deleted. Deleted data can be restored.
  CHECK (project_id IS NULL OR agent_id IS NULL)
);
CREATE INDEX data_schema ON data(schema_id);
CREATE INDEX data_project ON data(project_id);
CREATE INDEX data_agent ON data(agent_id);

-- Every state a piece of data has had, oldest first, including the current
-- one (decision 24). A delete is a version with deleted = 1 and the last
-- value. A bump to a newer schema version (decision 11) is not a version.
CREATE TABLE data_versions (
  data_id        TEXT NOT NULL REFERENCES data(id),
  seq            INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  value          TEXT NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0,
  author         TEXT NOT NULL CHECK (author IN ('user', 'model')),
  -- For the model: the session and run that made the change. Set to NULL
  -- when that session is purged; the version itself is kept.
  session_id     TEXT REFERENCES sessions(id),
  run_id         TEXT REFERENCES runs(id),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (data_id, seq)
);
CREATE INDEX data_versions_session ON data_versions(session_id);
