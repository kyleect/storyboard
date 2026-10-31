-- Initial schema.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Transcript. `message` is the provider-neutral message as JSON.
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq        INTEGER NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

-- Run history.
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  kind        TEXT NOT NULL,
  -- The assistant message this run writes to.
  message_id  TEXT NOT NULL,
  status      TEXT NOT NULL, -- running | finished | failed | cancelled | interrupted
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  usage       TEXT, -- JSON
  error       TEXT
);
CREATE INDEX runs_session ON runs(session_id);
CREATE INDEX runs_status ON runs(status);

-- Run events. `id` is the replay ID sent as the SSE event ID.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  time       TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL -- JSON
);
CREATE INDEX events_session ON events(session_id, id);
CREATE INDEX events_run ON events(run_id, id);
