-- Files get a media type and folders (files unification design, D3, D6).
--
-- A file's `type` (plain, markdown, json) becomes `media_type` (text/plain,
-- text/markdown, application/json). The column no longer lists its values:
-- binary files bring more, and the code checks them.
--
-- SQLite cannot change a CHECK, so `entries` and `entry_versions` are
-- rebuilt, child first on the way out and parent first on the way in, so no
-- foreign key is ever broken.

CREATE TABLE entries_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  project_id TEXT REFERENCES projects(id), -- NULL: global
  key        TEXT NOT NULL, -- the file path, or the note's generated id
  -- Files only: what the value is, as a media type.
  media_type TEXT,
  value      TEXT NOT NULL, -- for a deleted entry, its last value
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT, -- NULL: not deleted. Deleted entries can be restored.
  CHECK ((kind = 'file') = (media_type IS NOT NULL))
);

CREATE TABLE entry_versions_new (
  entry_id   TEXT NOT NULL REFERENCES entries_new(id),
  seq        INTEGER NOT NULL,
  media_type TEXT,
  value      TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  author     TEXT NOT NULL CHECK (author IN ('user', 'model')),
  session_id TEXT REFERENCES sessions(id),
  run_id     TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, seq)
);

INSERT INTO entries_new (id, kind, project_id, key, media_type, value, created_at, updated_at, deleted_at)
SELECT id, kind, project_id, key,
  CASE type
    WHEN 'plain' THEN 'text/plain'
    WHEN 'markdown' THEN 'text/markdown'
    WHEN 'json' THEN 'application/json'
  END,
  value, created_at, updated_at, deleted_at
FROM entries;

INSERT INTO entry_versions_new (entry_id, seq, media_type, value, deleted, author, session_id, run_id, created_at)
SELECT entry_id, seq,
  CASE type
    WHEN 'plain' THEN 'text/plain'
    WHEN 'markdown' THEN 'text/markdown'
    WHEN 'json' THEN 'application/json'
  END,
  value, deleted, author, session_id, run_id, created_at
FROM entry_versions;

DROP TABLE entry_versions;
DROP TABLE entries;

ALTER TABLE entries_new RENAME TO entries;
ALTER TABLE entry_versions_new RENAME TO entry_versions;

-- One entry per kind, scope and key. Keys are case-sensitive.
CREATE UNIQUE INDEX entries_key ON entries(kind, coalesce(project_id, ''), key);
CREATE INDEX entries_project ON entries(project_id);
CREATE INDEX entry_versions_session ON entry_versions(session_id);

-- Explicit folders of project and global files. A folder that only holds
-- files has no row; a row makes an empty folder exist. Session folders are
-- kept in the transcript. Deleting a folder deletes the row and soft-deletes
-- the files inside it.
CREATE TABLE folders (
  project_id TEXT REFERENCES projects(id), -- NULL: global
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX folders_path ON folders(coalesce(project_id, ''), path);

-- Changes to stored data that SQL cannot make (JSON inside messages), run
-- once each by the backend after the migrations (`data-steps.ts`).
CREATE TABLE data_steps (
  name    TEXT PRIMARY KEY,
  done_at TEXT NOT NULL
);
