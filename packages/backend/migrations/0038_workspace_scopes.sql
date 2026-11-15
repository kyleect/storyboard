-- Workspaces at a scope (workspaces in files design, Q1 to Q3).
--
-- A workspace is owned by the profile (global), by one project or by one
-- session, like files are, and a session sees its own, its project's and the
-- global ones. Attaching goes away: a workspace is visible where it is
-- defined. The "read-only here" choice of an attachment goes with it; read-only
-- is set on the workspace.
--
-- A workspace can also be temporary: a folder the app made inside its data
-- folder for one session.
--
-- Existing workspaces are converted from their attachments (Q2 A):
--   * attached to exactly one project or session: it becomes that owner's, and
--     is writable only if it was writable there (the workspace and its
--     attachment both said so);
--   * attached to several owners, or to none: it becomes global and read-only,
--     so nothing that was not visible before can now be written to without the
--     user making it writable again.
-- Ids stay the same, so references, "Always allow" grants and the search index
-- keep working.
--
-- As in 0037 the children go first on the way out and the parent first on the
-- way in, so no foreign key is ever broken.

-- The attachments that still point at an owner that exists.
CREATE TABLE workspace_owner_save AS
  SELECT a.workspace_id, a.owner_kind, a.owner_id, a.read_only
  FROM workspace_attachments a
  WHERE (a.owner_kind = 'project'
         AND EXISTS (SELECT 1 FROM projects p WHERE p.id = a.owner_id))
     OR (a.owner_kind = 'session'
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = a.owner_id));

CREATE TABLE workspace_index_files_save AS SELECT * FROM workspace_index_files;
DROP TABLE workspace_index_files;
DROP TABLE workspace_attachments;

CREATE TABLE workspaces_new (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL DEFAULT 'default',
  -- At most one owner; neither means global.
  project_id  TEXT REFERENCES projects(id),
  session_id  TEXT REFERENCES sessions(id),
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,           -- the absolute folder
  writable    INTEGER NOT NULL DEFAULT 0,
  -- 1: the folder was made by the app for the session and is deleted with it.
  temporary   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  index_ticks TEXT NOT NULL DEFAULT '[]',
  CHECK (project_id IS NULL OR session_id IS NULL),
  CHECK (temporary = 0 OR session_id IS NOT NULL)
);

INSERT INTO workspaces_new
  (id, profile_id, project_id, session_id, name, path, writable, temporary,
   created_at, updated_at, deleted_at, index_ticks)
SELECT
  w.id,
  w.profile_id,
  CASE WHEN o.n = 1
    THEN (SELECT t.owner_id FROM workspace_owner_save t
          WHERE t.workspace_id = w.id AND t.owner_kind = 'project') END,
  CASE WHEN o.n = 1
    THEN (SELECT t.owner_id FROM workspace_owner_save t
          WHERE t.workspace_id = w.id AND t.owner_kind = 'session') END,
  w.name,
  w.path,
  CASE WHEN o.n = 1
    THEN CASE WHEN w.writable = 1 AND NOT EXISTS (
           SELECT 1 FROM workspace_owner_save t
           WHERE t.workspace_id = w.id AND t.read_only = 1)
         THEN 1 ELSE 0 END
    ELSE 0 END,
  0,
  w.created_at,
  w.updated_at,
  w.deleted_at,
  w.index_ticks
FROM workspaces w
JOIN (
  SELECT w2.id AS id,
         (SELECT COUNT(*) FROM workspace_owner_save t WHERE t.workspace_id = w2.id) AS n
  FROM workspaces w2
) o ON o.id = w.id;

DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;

-- One name per owner. A session's "scratch" and a global "scratch" can both
-- exist (Q3 A).
CREATE UNIQUE INDEX workspaces_name
  ON workspaces(profile_id, coalesce(project_id, ''), coalesce(session_id, ''), name);
CREATE INDEX workspaces_project ON workspaces(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX workspaces_session ON workspaces(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE workspace_index_files (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  path         TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
INSERT INTO workspace_index_files SELECT * FROM workspace_index_files_save;
DROP TABLE workspace_index_files_save;
DROP TABLE workspace_owner_save;
