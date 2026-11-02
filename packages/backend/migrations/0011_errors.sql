-- Errors for the errors consoles (error reporting plan, P4): tool errors and
-- failed runs. Rows are removed with their session (Store.purgeSession) or
-- by Clear.

CREATE TABLE errors (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  run_id      TEXT REFERENCES runs(id),
  -- The tool result message that holds the error; NULL for a failed run.
  message_id  TEXT,
  call_id     TEXT, -- NULL for a failed run
  source      TEXT NOT NULL CHECK (source IN ('tool', 'run')),
  -- 'tool_threw', 'tool_returned_error', 'unknown_tool',
  -- 'invalid_arguments', 'malformed_call' or 'run_failed'.
  kind        TEXT NOT NULL,
  tool_name   TEXT, -- NULL for a failed run
  message     TEXT NOT NULL, -- the full error text
  -- JSON: { details?, stack?, arguments? }. NULL when there is none.
  details     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX errors_session_time ON errors(session_id, created_at);
CREATE INDEX errors_time ON errors(created_at);
