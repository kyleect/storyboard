-- Tools (tools design 6.5, 6.10).

-- The messages each run wrote, in order. A message can belong to more than
-- one run: a continue writes into a message an earlier run created.
CREATE TABLE run_messages (
  run_id     TEXT NOT NULL REFERENCES runs(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  seq        INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, message_id)
);
CREATE INDEX run_messages_message ON run_messages(message_id);

-- Until now each run wrote one message, named in runs.message_id. A run
-- whose message was never saved (it produced no content) gets no row.
INSERT INTO run_messages (run_id, message_id, seq)
  SELECT r.id, r.message_id, 1 FROM runs r
  WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id);

ALTER TABLE runs DROP COLUMN message_id;

-- "Allow for this session" answers to approval requests.
CREATE TABLE session_tool_approvals (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_name  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_name)
);
