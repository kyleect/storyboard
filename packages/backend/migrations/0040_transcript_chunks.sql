-- Search over the messages of earlier sessions (session rollover design, D13).
--
-- A session that was continued in a new one keeps its messages in the search
-- index under a new scope, `transcript`: the owner is the session, the key is
-- the message id and the sequence number is the place within that message.
--
-- SQLite cannot change a CHECK constraint, so `chunks` is rebuilt as in 0030
-- and 0034: the vectors are saved first (they point at `chunks`, and dropping
-- it would delete them), ids stay the same, the full-text index is rebuilt
-- from the copied rows, and the vectors are put back. `profile_id` was added
-- by 0037 after the last rebuild, so it is carried here.

CREATE TABLE chunk_vectors_save AS SELECT chunk_id, model, embedding FROM chunk_vectors;
DROP TABLE chunk_vectors;

DROP TRIGGER chunks_fts_insert;
DROP TRIGGER chunks_fts_delete;
DROP TABLE chunks_fts;

CREATE TABLE chunks_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global', 'workspace', 'transcript')),
  -- The session, project or workspace; NULL for global. No foreign key: it
  -- points at one of three tables.
  owner_id   TEXT,
  key        TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  profile_id TEXT NOT NULL DEFAULT 'default',
  CHECK ((scope = 'global') = (owner_id IS NULL))
);
INSERT INTO chunks_new (id, scope, owner_id, key, seq, text, profile_id)
  SELECT id, scope, owner_id, key, seq, text, profile_id FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX chunks_file ON chunks(scope, owner_id, key);
CREATE INDEX chunks_profile ON chunks(profile_id, scope);

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
