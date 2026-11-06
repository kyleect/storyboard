-- Tool grants (tool management design, decisions 1, 5, 6, 9, 17; plan 1.4).
--
-- An agent's plain tool list (`tool_mode`, `tools`) becomes one JSON grant:
-- groups, exceptions, extras and the tools that existed when the version was
-- saved. Existing agents and their versions are converted so they keep the
-- same tools:
--   - a group is granted (allow) or denied (deny) only when the old list holds
--     every tool of that group,
--   - every other listed tool becomes an extra,
--   - `known` is the 41 tools of today, so nothing shows as new.
-- The old columns are then removed.

-- Today's tools and their groups (a copy: a migration must not depend on
-- later code).
CREATE TEMP TABLE tool_group_map (tool TEXT PRIMARY KEY, grp TEXT NOT NULL);
INSERT INTO tool_group_map (tool, grp) VALUES
  ('files_list', 'files'),
  ('files_read', 'files'),
  ('files_write', 'files'),
  ('files_delete', 'files'),
  ('files_search', 'files'),
  ('files_copy', 'files'),
  ('files_move', 'files'),
  ('memory_list', 'memory'),
  ('memory_add', 'memory'),
  ('memory_update', 'memory'),
  ('memory_delete', 'memory'),
  ('memory_search', 'memory'),
  ('memory_copy', 'memory'),
  ('memory_move', 'memory'),
  ('schemas_list', 'structured-data'),
  ('schema_view', 'structured-data'),
  ('schema_create', 'structured-data'),
  ('schema_update', 'structured-data'),
  ('schema_copy', 'structured-data'),
  ('schema_delete', 'structured-data'),
  ('data_list', 'structured-data'),
  ('data_view', 'structured-data'),
  ('data_create', 'structured-data'),
  ('data_update', 'structured-data'),
  ('data_migrate', 'structured-data'),
  ('data_migrate_many', 'structured-data'),
  ('data_delete', 'structured-data'),
  ('projects_list', 'projects'),
  ('project_view', 'projects'),
  ('project_create', 'projects'),
  ('agents_list', 'agents'),
  ('agent_view', 'agents'),
  ('start_subagent', 'subagents'),
  ('subagent_handback', 'subagents'),
  ('skill_load', 'skills'),
  ('web_search', 'web'),
  ('read_webpage', 'web'),
  ('read_wiki', 'web'),
  ('current_date', 'utilities'),
  ('current_time', 'utilities'),
  ('ask_user', 'utilities');

ALTER TABLE agents ADD COLUMN tool_grant TEXT NOT NULL DEFAULT '{"mode":"allow","groups":[],"except":[],"extras":[],"known":[]}';
ALTER TABLE agent_versions ADD COLUMN tool_grant TEXT NOT NULL DEFAULT '{"mode":"allow","groups":[],"except":[],"extras":[],"known":[]}';

-- The groups whose every tool is in the row's list.
UPDATE agents SET tool_grant = json_object(
  'mode', tool_mode,
  'groups', json((
    SELECT json_group_array(g.grp)
    FROM (SELECT DISTINCT grp FROM tool_group_map) g
    WHERE NOT EXISTS (
      SELECT 1 FROM tool_group_map m
      WHERE m.grp = g.grp
        AND m.tool NOT IN (SELECT value FROM json_each(agents.tools))
    )
  )),
  'except', json('[]'),
  'extras', json((
    SELECT json_group_array(e.value)
    FROM json_each(agents.tools) e
    WHERE NOT EXISTS (
      SELECT 1 FROM tool_group_map m
      WHERE m.tool = e.value
        AND NOT EXISTS (
          SELECT 1 FROM tool_group_map m2
          WHERE m2.grp = m.grp
            AND m2.tool NOT IN (SELECT value FROM json_each(agents.tools))
        )
    )
  )),
  'known', json((SELECT json_group_array(tool) FROM tool_group_map))
);

UPDATE agent_versions SET tool_grant = json_object(
  'mode', tool_mode,
  'groups', json((
    SELECT json_group_array(g.grp)
    FROM (SELECT DISTINCT grp FROM tool_group_map) g
    WHERE NOT EXISTS (
      SELECT 1 FROM tool_group_map m
      WHERE m.grp = g.grp
        AND m.tool NOT IN (SELECT value FROM json_each(agent_versions.tools))
    )
  )),
  'except', json('[]'),
  'extras', json((
    SELECT json_group_array(e.value)
    FROM json_each(agent_versions.tools) e
    WHERE NOT EXISTS (
      SELECT 1 FROM tool_group_map m
      WHERE m.tool = e.value
        AND NOT EXISTS (
          SELECT 1 FROM tool_group_map m2
          WHERE m2.grp = m.grp
            AND m2.tool NOT IN (SELECT value FROM json_each(agent_versions.tools))
        )
    )
  )),
  'known', json((SELECT json_group_array(tool) FROM tool_group_map))
);

DROP TABLE tool_group_map;

ALTER TABLE agents DROP COLUMN tool_mode;
ALTER TABLE agents DROP COLUMN tools;
ALTER TABLE agent_versions DROP COLUMN tool_mode;
ALTER TABLE agent_versions DROP COLUMN tools;
