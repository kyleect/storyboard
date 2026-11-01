-- Trash (sessions and projects design, 5.2).

-- When the session was moved to the trash. NULL: not in the trash.
ALTER TABLE sessions ADD COLUMN trashed_at TEXT;

-- Events that belong to no run (for example session.trashed) have no run_id
-- (design Q7b). SQLite cannot drop NOT NULL in place, so the table is
-- rebuilt. Rows keep their ids, so stored replay ids stay valid.
CREATE TABLE events_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT REFERENCES runs(id), -- NULL: not part of a run
  session_id TEXT NOT NULL REFERENCES sessions(id),
  time       TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL -- JSON
);
INSERT INTO events_new (id, run_id, session_id, time, type, data)
  SELECT id, run_id, session_id, time, type, data FROM events;

-- Keep the AUTOINCREMENT counter, so ids are never reused.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'events_new', seq FROM sqlite_sequence WHERE name = 'events'
  AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events_new');
UPDATE sqlite_sequence
  SET seq = max(seq, (SELECT coalesce(max(seq), 0) FROM sqlite_sequence WHERE name = 'events'))
  WHERE name = 'events_new';

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_session ON events(session_id, id);
CREATE INDEX events_run ON events(run_id, id);
