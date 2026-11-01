-- Search over files and memory notes (files and memory design, decisions 22
-- to 30; plan P2, P8, S1 to S8).

-- Live entries split into chunks: one per note, files split at about 1,500
-- characters (S1, S2). Deleted entries have no chunks. Session-scoped
-- entries are indexed here too, though they live in the transcript.
CREATE TABLE chunks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL CHECK (kind IN ('file', 'note')),
  scope    TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global')),
  -- The session or project; NULL for global. No foreign key: it points at
  -- either table. Purging a session or project deletes its chunks.
  owner_id TEXT,
  key      TEXT NOT NULL,
  seq      INTEGER NOT NULL, -- position in the entry, from 0
  text     TEXT NOT NULL,
  CHECK ((scope = 'global') = (owner_id IS NULL))
);
CREATE INDEX chunks_entry ON chunks(scope, owner_id, kind, key);

-- Keyword search, with Porter stemming (S4). Kept in step by triggers.
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

-- One vector per chunk, from the current embedding model (S6). A chunk
-- without a row here is waiting to be embedded (P8). Searched with
-- sqlite-vec's vec_distance_cosine (P2).
CREATE TABLE chunk_vectors (
  chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  embedding BLOB NOT NULL -- float32, little-endian
);

-- Existing entries are indexed once by the backend after this migration
-- (chunking is done in TypeScript); built = 1 afterwards.
CREATE TABLE search_index_state (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  built INTEGER NOT NULL
);
INSERT INTO search_index_state (id, built) VALUES (1, 0);
