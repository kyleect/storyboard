-- Binary files (files unification design, D2, D11, D12).
--
-- The bytes of a binary file are kept here once, by the SHA-256 of their
-- content. A file record and each of its versions point at a blob; a
-- session file points at it from an operation in the transcript. A blob
-- nothing points at is deleted by a sweep (`blobs.ts`), after versions are
-- pruned or a project or session is purged.
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY, -- hex SHA-256 of the bytes
  media_type TEXT NOT NULL,    -- checked against the bytes at upload
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- A binary file has a media type, an empty `value`, and its bytes here.
ALTER TABLE entries ADD COLUMN blob_hash TEXT REFERENCES blobs(hash);
ALTER TABLE entries ADD COLUMN size INTEGER;
ALTER TABLE entry_versions ADD COLUMN blob_hash TEXT REFERENCES blobs(hash);
ALTER TABLE entry_versions ADD COLUMN size INTEGER;

CREATE INDEX entries_blob ON entries(blob_hash) WHERE blob_hash IS NOT NULL;
CREATE INDEX entry_versions_blob ON entry_versions(blob_hash) WHERE blob_hash IS NOT NULL;

-- The `attachments` table (0024) is emptied into session files and dropped by
-- the data step `attachments-to-files` (`data-steps.ts`), because the move
-- needs hashes and edits to the stored messages that SQL cannot make.
