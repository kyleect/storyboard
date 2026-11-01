-- Files and memory (files and memory design). Project and global entries
-- only: session-scoped entries are rebuilt from the transcript (decision 11).
-- 0007 is left free for the context usage work; the runner allows gaps.

CREATE TABLE entries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  project_id TEXT REFERENCES projects(id), -- NULL: global
  key        TEXT NOT NULL, -- the file key, or the note's generated id
  -- Files only: how the value is shown (decision 5).
  type       TEXT CHECK (type IN ('plain', 'markdown', 'json')),
  value      TEXT NOT NULL, -- for a deleted entry, its last value
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT, -- NULL: not deleted. Deleted entries can be restored.
  CHECK ((kind = 'file') = (type IS NOT NULL))
);
-- One entry per kind, scope and key. Keys are case-sensitive (decision 6).
CREATE UNIQUE INDEX entries_key ON entries(kind, coalesce(project_id, ''), key);
CREATE INDEX entries_project ON entries(project_id);

-- Every state an entry has had, oldest first, including the current one
-- (decision 8). A delete is a version with deleted = 1 and the last value.
CREATE TABLE entry_versions (
  entry_id   TEXT NOT NULL REFERENCES entries(id),
  seq        INTEGER NOT NULL,
  type       TEXT,
  value      TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  author     TEXT NOT NULL CHECK (author IN ('user', 'model')),
  -- For the model: the session and run that made the change. Set to NULL
  -- when that session is purged; the version itself is kept.
  session_id TEXT REFERENCES sessions(id),
  run_id     TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, seq)
);
CREATE INDEX entry_versions_session ON entry_versions(session_id);
