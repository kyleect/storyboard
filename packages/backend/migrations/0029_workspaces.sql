-- Workspaces (files unification design, D22 to D36, D46).
--
-- A workspace is a named folder on the computer, in one global list. It is
-- read-only or writable, attached to projects and sessions (a session also
-- has its project's), and removed to the trash like an agent: the folder on
-- disk is never touched, and while a workspace is in the trash it is not
-- available anywhere. Its attachments are kept, so a restore brings it back
-- where it was.
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL,           -- the absolute folder
  writable   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- An attachment can make the workspace read-only for its owner, never writable
-- when the workspace is not (D26). A project's and a session's both apply.
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

-- "Always allow" for a tool and a subject, such as one workspace (D27).
-- A tool with no subject keeps its grant in the settings, as before.
CREATE TABLE tool_subject_grants (
  tool         TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (tool, subject_kind, subject_id)
);

-- "Allow for this session" for a tool and a subject.
CREATE TABLE session_subject_approvals (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  tool_name    TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name, subject_kind, subject_id)
);
