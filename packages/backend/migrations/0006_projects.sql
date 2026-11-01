-- Projects (sessions and projects design, 5.3).

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '', -- empty when there is none
  created_at   TEXT NOT NULL,
  -- Last time a session was created in it, a message was sent or continued
  -- in one of its sessions, or it was edited (Q15a).
  last_used_at TEXT NOT NULL,
  trashed_at   TEXT -- NULL: not in the trash
);
CREATE INDEX projects_used ON projects(last_used_at);

-- NULL: a standalone session. Existing sessions become standalone. Fixed
-- when the session is created (Q11).
ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
-- 1 when the session went to the trash because its project did (Q12c).
ALTER TABLE sessions ADD COLUMN trashed_with_project INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_project ON sessions(project_id);
