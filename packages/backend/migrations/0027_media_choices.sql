-- The user's choice to keep an image or audio file in the model's view in
-- later turns, or to drop it (files unification design, D14, D40). One row
-- per session and file reference. No row: the agent's choice, then the
-- global setting, decide.
CREATE TABLE media_choices (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ref        TEXT NOT NULL,    -- such as session://cat.png
  keep       INTEGER NOT NULL, -- 1 keep inline, 0 drop to a text reference
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, ref)
);
