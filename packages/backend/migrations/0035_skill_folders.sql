-- Skills as folders (skills folders design, decisions 6 to 10, 14). A skill
-- is a folder: a SKILL.md and any other files. Each skill version holds a
-- manifest of the folder as it was; the content of every file is kept once,
-- by hash, in `blobs`, so a file that did not change costs nothing in a new
-- version.
--
-- The data step `skills-to-folders` (`data-steps.ts`) writes the SKILL.md of
-- every existing version: it needs hashes and YAML, which SQL cannot make.
--
-- `skills.display_name` and `skills.body` (and the same two columns of
-- `skill_versions`) are no longer used: a new version stores the name there
-- and an empty body. They stay because the data step reads them and SQLite
-- cannot drop a NOT NULL column without rebuilding the table; a later
-- migration can rebuild the tables once every database has run the step.
CREATE TABLE skill_files (
  skill_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL, -- the skill version this manifest belongs to
  path       TEXT NOT NULL,    -- inside the folder, "/"-separated
  media_type TEXT NOT NULL,
  size       INTEGER NOT NULL,
  -- NULL: the bytes were pruned (a binary file keeps its last three
  -- contents, decision 10). The row stays so the version can still be
  -- restored, with the file shown as missing.
  blob_hash  TEXT,
  PRIMARY KEY (skill_id, seq, path),
  FOREIGN KEY (skill_id, seq) REFERENCES skill_versions(skill_id, seq)
);
CREATE INDEX skill_files_blob ON skill_files(blob_hash) WHERE blob_hash IS NOT NULL;

-- The versions of the skills a run was given, for debugging (decision 8):
-- a JSON array of { id, name, scope, version }. NULL: before this column.
ALTER TABLE runs ADD COLUMN skill_versions TEXT;
