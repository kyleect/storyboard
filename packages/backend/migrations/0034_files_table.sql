-- Files only. With memory gone, `entries` held nothing but files, so the
-- tables take the name `files` and lose `kind`, which could only be 'file'.
--
-- SQLite cannot drop a column that a CHECK or an index names, nor rename an
-- index, so `entries`, `entry_versions` and `chunks` are rebuilt. The order
-- keeps every foreign key whole: the child goes first on the way out and the
-- parent first on the way in (as in 0025). Migration 0033 already removed
-- every note, so every row copied here is a file.
--
-- The stored transcripts change in the data step `files-rename`, which runs
-- after this migration.

CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id), -- NULL: global
  key        TEXT NOT NULL, -- the file path
  media_type TEXT NOT NULL,
  value      TEXT NOT NULL, -- for a deleted file, its last value
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT, -- NULL: not deleted. Deleted files can be restored.
  blob_hash  TEXT REFERENCES blobs(hash),
  size       INTEGER
);

CREATE TABLE file_versions (
  file_id    TEXT NOT NULL REFERENCES files(id),
  seq        INTEGER NOT NULL,
  media_type TEXT,
  value      TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  author     TEXT NOT NULL CHECK (author IN ('user', 'model')),
  session_id TEXT REFERENCES sessions(id),
  run_id     TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL,
  blob_hash  TEXT REFERENCES blobs(hash),
  size       INTEGER,
  PRIMARY KEY (file_id, seq)
);

INSERT INTO files (id, project_id, key, media_type, value, created_at, updated_at, deleted_at, blob_hash, size)
  SELECT id, project_id, key, media_type, value, created_at, updated_at, deleted_at, blob_hash, size
  FROM entries WHERE kind = 'file';

INSERT INTO file_versions (file_id, seq, media_type, value, deleted, author, session_id, run_id, created_at, blob_hash, size)
  SELECT entry_id, seq, media_type, value, deleted, author, session_id, run_id, created_at, blob_hash, size
  FROM entry_versions WHERE entry_id IN (SELECT id FROM files);

DROP TABLE entry_versions;
DROP TABLE entries;

-- One file per scope and key. Keys are case-sensitive.
CREATE UNIQUE INDEX files_key ON files(coalesce(project_id, ''), key);
CREATE INDEX files_project ON files(project_id);
CREATE INDEX files_blob ON files(blob_hash) WHERE blob_hash IS NOT NULL;
CREATE INDEX file_versions_session ON file_versions(session_id);
CREATE INDEX file_versions_blob ON file_versions(blob_hash) WHERE blob_hash IS NOT NULL;

-- ---- Search chunks: `kind` goes ---------------------------------------------
-- As in 0030: every chunk keeps its id, the full-text index is rebuilt from
-- the copied rows, and the vectors are put back. The vectors go first because
-- they point at `chunks`, and dropping it would delete them.
CREATE TABLE chunk_vectors_save AS SELECT chunk_id, model, embedding FROM chunk_vectors;
DROP TABLE chunk_vectors;

DROP TRIGGER chunks_fts_insert;
DROP TRIGGER chunks_fts_delete;
DROP TABLE chunks_fts;

CREATE TABLE chunks_new (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  scope    TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global', 'workspace')),
  -- The session, project or workspace; NULL for global. No foreign key: it
  -- points at one of three tables.
  owner_id TEXT,
  key      TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  text     TEXT NOT NULL,
  CHECK ((scope = 'global') = (owner_id IS NULL))
);
INSERT INTO chunks_new (id, scope, owner_id, key, seq, text)
  SELECT id, scope, owner_id, key, seq, text FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX chunks_file ON chunks(scope, owner_id, key);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);
CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, text)
    VALUES ('delete', old.id, old.text);
END;
INSERT INTO chunks_fts (chunks_fts) VALUES ('rebuild');

CREATE TABLE chunk_vectors (
  chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  embedding BLOB NOT NULL
);
INSERT INTO chunk_vectors (chunk_id, model, embedding)
  SELECT chunk_id, model, embedding FROM chunk_vectors_save;
DROP TABLE chunk_vectors_save;

-- ---- Stored events ------------------------------------------------------------
-- The event for a change the user made to session files has a new name.
UPDATE events SET type = 'session.files_changed'
  WHERE type = 'session.entries_changed';
