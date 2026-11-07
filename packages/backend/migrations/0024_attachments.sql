-- Files the user attached to messages (images and audio for models that
-- read them). The message keeps only a description of each (`attachments` in
-- the user message's JSON); the bytes live here, under the same id, so the
-- message rows stay small. A file is uploaded to a session before the
-- message that uses it is sent, so a row can exist that no message uses; it
-- goes with the session when the session is purged.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio')),
  media_type TEXT NOT NULL,
  name TEXT,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_session ON attachments (session_id);
