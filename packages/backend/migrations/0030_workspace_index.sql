-- Workspace indexing (files unification design, D31, D45, D53; plan Q8).

-- What the user chose to search in a workspace: a JSON array of paths
-- relative to its folder, folders and files; "" is the whole folder. A new
-- file in a ticked folder is included. The ticks belong to the workspace, so
-- one index serves every project and session that attaches it.
ALTER TABLE workspaces ADD COLUMN index_ticks TEXT NOT NULL DEFAULT '[]';

-- What was last indexed of each file, so a rescan at the start of a session
-- reads only the files that changed.
CREATE TABLE workspace_index_files (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  path         TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path)
);

-- `chunks` takes `workspace` as a fourth scope, with the workspace id as its
-- owner and the path inside the workspace as its key. SQLite cannot change a
-- CHECK, so the table is rebuilt: every chunk keeps its id, the full-text
-- index is rebuilt from the copied rows, and the vectors are put back. The
-- vectors go first because they point at `chunks`, and dropping it would
-- delete them.
CREATE TABLE chunk_vectors_save AS SELECT chunk_id, model, embedding FROM chunk_vectors;
DROP TABLE chunk_vectors;

DROP TRIGGER chunks_fts_insert;
DROP TRIGGER chunks_fts_delete;
DROP TABLE chunks_fts;

CREATE TABLE chunks_new (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  scope    TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global', 'workspace')),
  -- The session, project or workspace; NULL for global. No foreign key: it
  -- points at one of three tables.
  owner_id TEXT,
  key      TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  text     TEXT NOT NULL,
  CHECK ((scope = 'global') = (owner_id IS NULL))
);
INSERT INTO chunks_new (id, kind, scope, owner_id, key, seq, text)
  SELECT id, kind, scope, owner_id, key, seq, text FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX chunks_entry ON chunks(scope, owner_id, kind, key);

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
