-- Derived text and the built-in Media Describer agent (files unification
-- design, D18, D43, D44, D56 to D60).
--
-- A description or transcript of an image or audio file is kept with its
-- bytes, so it serves a file in any scope, in a session's transcript or in
-- the tables, and is not lost when a version is pruned. Identical bytes share
-- one text. `derived_state` says where it came from:
--   none       nothing yet (generation was off, or has not run)
--   pending    a generation is running
--   generated  written by the Media Describer
--   edited     written or changed by the user
--   failed     a generation did not finish; shown as "not generated"
ALTER TABLE blobs ADD COLUMN derived_text TEXT NOT NULL DEFAULT '';
ALTER TABLE blobs ADD COLUMN derived_state TEXT NOT NULL DEFAULT 'none'
  CHECK (derived_state IN ('none', 'pending', 'generated', 'edited', 'failed'));

-- The built-in Media Describer: read-only, no tools, startable as a subagent.
INSERT INTO agents (id, project_id, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, version, builtin, created_at, updated_at)
VALUES (
  'builtin-media-describer', NULL, 'Media Describer',
  'Describes one image or audio file in text, so it can be searched and understood by a model that cannot see or hear it.',
  'You describe one image or audio file so that someone who cannot see or hear it can understand it, and so that search can find it. For an image, describe the subject, setting, visible text, notable details and style. For audio, give a verbatim transcript of speech and a short note on other sounds or music. Describe only what you can see or hear. Do not guess at names, intent or meaning. Reply in plain text with no headings or introduction, in about 200 words unless a transcript needs more.',
  '{"mode":"allow","groups":[],"except":[],"extras":[],"known":[]}', '{}', NULL, NULL, 1, 1, 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO agent_versions (agent_id, seq, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, deleted, created_at)
SELECT id, 1, name, description, prompt, tool_grant, tool_approval, child_reminders, child_prompt, subagent, 0, created_at
FROM agents WHERE id = 'builtin-media-describer';
