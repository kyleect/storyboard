-- Profiles (profiles design, section 4).
--
-- A profile is one isolated workspace: its own global, project, agent and
-- session scopes, settings, MCP servers, workspaces, tool grants and error
-- log. Existing data becomes the profile "default".
--
-- `profile_id` is not a foreign key. With foreign keys on, SQLite refuses
-- ADD COLUMN ... REFERENCES ... DEFAULT <not null>; the stores set it and a
-- test checks that every row agrees with its owner (design decision 5).
--
-- Built-in agents, skills and schemas are shared by every profile, so they get
-- the profile 'builtin' and are found by `builtin = 1`, never by profile.
-- A built-in inserted by a later migration must say so (design decision 6).

CREATE TABLE profiles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  trashed_at   TEXT -- NULL: not in the trash
);
-- Unique among profiles that are not in the trash.
CREATE UNIQUE INDEX profiles_name ON profiles(name) WHERE trashed_at IS NULL;

INSERT INTO profiles (id, name, created_at, last_used_at) VALUES
  ('default', 'Default',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- App-wide state that belongs to no profile; today only the active one.
CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_state (key, value) VALUES ('activeProfile', 'default');

-- ---- Owner on every scoped table ---------------------------------------------
-- A project's children carry their project's profile, so one filter and one
-- unique index serve every scope.
ALTER TABLE projects ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE files    ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE agents   ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE skills   ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE schemas  ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE data     ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chunks   ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE errors   ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE folders  ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default';

UPDATE agents  SET profile_id = 'builtin' WHERE builtin = 1;
UPDATE skills  SET profile_id = 'builtin' WHERE builtin = 1;
UPDATE schemas SET profile_id = 'builtin' WHERE builtin = 1;

CREATE INDEX projects_profile ON projects(profile_id);
CREATE INDEX sessions_profile ON sessions(profile_id);
CREATE INDEX data_profile     ON data(profile_id);
CREATE INDEX chunks_profile   ON chunks(profile_id, scope);
CREATE INDEX errors_profile   ON errors(profile_id, created_at);

-- ---- Names are unique per profile --------------------------------------------
DROP INDEX folders_path;
CREATE UNIQUE INDEX folders_path
  ON folders(profile_id, coalesce(project_id, ''), path);

DROP INDEX files_key;
CREATE UNIQUE INDEX files_key
  ON files(profile_id, coalesce(project_id, ''), key);

DROP INDEX agents_name;
CREATE UNIQUE INDEX agents_name
  ON agents(profile_id, builtin, coalesce(project_id, ''), name);

DROP INDEX skills_name;
CREATE UNIQUE INDEX skills_name
  ON skills(profile_id, builtin, coalesce(project_id, ''), coalesce(agent_id, ''), name);

DROP INDEX schemas_name;
CREATE UNIQUE INDEX schemas_name
  ON schemas(profile_id, builtin, coalesce(project_id, ''), coalesce(agent_id, ''), name);

-- ---- Settings: one set per profile ---------------------------------------------
-- SQLite cannot change a primary key, so the table is rebuilt.
CREATE TABLE settings_new (
  profile_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL, -- JSON
  PRIMARY KEY (profile_id, key)
);
INSERT INTO settings_new (profile_id, key, value)
  SELECT 'default', key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- ---- MCP servers: the name is unique per profile -----------------------------
CREATE TABLE mcp_servers_new (
  id         TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL DEFAULT 'default',
  name       TEXT NOT NULL,
  transport  TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  config     TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (profile_id, name)
);
INSERT INTO mcp_servers_new (id, name, transport, config, enabled, created_at, updated_at)
  SELECT id, name, transport, config, enabled, created_at, updated_at FROM mcp_servers;
DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_new RENAME TO mcp_servers;

-- ---- Workspaces: the name is unique per profile --------------------------------
-- As in 0034: children go first on the way out and the parent first on the way
-- in, so no foreign key is ever broken. Ids stay the same.
CREATE TABLE workspace_attachments_save AS SELECT * FROM workspace_attachments;
CREATE TABLE workspace_index_files_save AS SELECT * FROM workspace_index_files;
DROP TABLE workspace_attachments;
DROP TABLE workspace_index_files;

CREATE TABLE workspaces_new (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL DEFAULT 'default',
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,           -- the absolute folder
  writable    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  index_ticks TEXT NOT NULL DEFAULT '[]',
  UNIQUE (profile_id, name)
);
INSERT INTO workspaces_new (id, name, path, writable, created_at, updated_at, deleted_at, index_ticks)
  SELECT id, name, path, writable, created_at, updated_at, deleted_at, index_ticks FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

CREATE TABLE workspace_attachments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_kind   TEXT NOT NULL CHECK (owner_kind IN ('project', 'session')),
  owner_id     TEXT NOT NULL,
  read_only    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner_kind, owner_id)
);
CREATE INDEX workspace_attachments_owner
  ON workspace_attachments(owner_kind, owner_id);
INSERT INTO workspace_attachments SELECT * FROM workspace_attachments_save;
DROP TABLE workspace_attachments_save;

CREATE TABLE workspace_index_files (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  path         TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
INSERT INTO workspace_index_files SELECT * FROM workspace_index_files_save;
DROP TABLE workspace_index_files_save;

-- ---- Tool grants: one list per profile -----------------------------------------
-- The primary key gains the profile, so two profiles can each grant a tool for
-- the same subject.
CREATE TABLE tool_subject_grants_new (
  profile_id   TEXT NOT NULL DEFAULT 'default',
  tool         TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (profile_id, tool, subject_kind, subject_id)
);
INSERT INTO tool_subject_grants_new (profile_id, tool, subject_kind, subject_id, created_at)
  SELECT 'default', tool, subject_kind, subject_id, created_at FROM tool_subject_grants;
DROP TABLE tool_subject_grants;
ALTER TABLE tool_subject_grants_new RENAME TO tool_subject_grants;
