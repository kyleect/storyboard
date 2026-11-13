-- Removing memory. The memory notes and their tools are gone; an MCP server
-- does this job now. Files stay.
--
-- This migration removes what SQL can reach. The notes in stored messages
-- (note changes and the `memory_*` calls) are removed by the data step
-- `memory-removal`, which runs after it.
--
-- This cannot be undone from inside the app: back up the database file
-- before applying it.

-- ---- Notes ---------------------------------------------------------------

-- The search chunks of notes. The full-text index follows through its
-- delete trigger, and the vectors through their ON DELETE CASCADE.
DELETE FROM chunks WHERE kind = 'note';

-- The notes themselves, with their versions.
DELETE FROM entry_versions
  WHERE entry_id IN (SELECT id FROM entries WHERE kind = 'note');
DELETE FROM entries WHERE kind = 'note';

-- ---- Tool names in stored settings and grants ------------------------------

-- The seven tools of the `memory` group, and the group itself, are taken out
-- of every agent's tool grant and of each version of it (tool management
-- design). `known` lists the tools that existed when the grant was saved.
UPDATE agents SET tool_grant = json_set(
  tool_grant,
  '$.groups', json((
    SELECT json_group_array(value) FROM json_each(agents.tool_grant, '$.groups')
    WHERE value <> 'memory'
  )),
  '$.except', json((
    SELECT json_group_array(value) FROM json_each(agents.tool_grant, '$.except')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  )),
  '$.extras', json((
    SELECT json_group_array(value) FROM json_each(agents.tool_grant, '$.extras')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  )),
  '$.known', json((
    SELECT json_group_array(value) FROM json_each(agents.tool_grant, '$.known')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  ))
);

UPDATE agent_versions SET tool_grant = json_set(
  tool_grant,
  '$.groups', json((
    SELECT json_group_array(value)
    FROM json_each(agent_versions.tool_grant, '$.groups')
    WHERE value <> 'memory'
  )),
  '$.except', json((
    SELECT json_group_array(value)
    FROM json_each(agent_versions.tool_grant, '$.except')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  )),
  '$.extras', json((
    SELECT json_group_array(value)
    FROM json_each(agent_versions.tool_grant, '$.extras')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  )),
  '$.known', json((
    SELECT json_group_array(value)
    FROM json_each(agent_versions.tool_grant, '$.known')
    WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
      'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
  ))
);

-- Each agent's own per-tool approval settings (agent tool approval design):
-- an object of tool name to true or false. Booleans stay booleans.
UPDATE agents SET tool_approval = (
  SELECT COALESCE(json_group_object(
    key,
    CASE type WHEN 'true' THEN json('true') ELSE json('false') END
  ), '{}')
  FROM json_each(agents.tool_approval)
  WHERE key NOT IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
);
UPDATE agent_versions SET tool_approval = (
  SELECT COALESCE(json_group_object(
    key,
    CASE type WHEN 'true' THEN json('true') ELSE json('false') END
  ), '{}')
  FROM json_each(agent_versions.tool_approval)
  WHERE key NOT IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
);

-- Per-tool settings: `toolApproval` and `toolAlwaysOn` are objects keyed by
-- tool name (booleans are kept as booleans), `toolsOff` is a list of names.
UPDATE settings SET value = (
  SELECT COALESCE(json_group_object(
    key,
    CASE type
      WHEN 'true' THEN json('true')
      WHEN 'false' THEN json('false')
      ELSE json(value)
    END
  ), '{}')
  FROM json_each(settings.value)
  WHERE key NOT IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
)
WHERE key IN ('toolApproval', 'toolAlwaysOn');

UPDATE settings SET value = (
  SELECT json_group_array(value) FROM json_each(settings.value)
  WHERE value NOT IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move')
)
WHERE key = 'toolsOff';

-- "Allow for this session" and "Always allow" rows for those tools.
DELETE FROM session_tool_approvals
  WHERE tool_name IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move');
DELETE FROM tool_subject_grants
  WHERE tool IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move');
DELETE FROM session_subject_approvals
  WHERE tool_name IN ('memory_list', 'memory_add', 'memory_update',
    'memory_delete', 'memory_search', 'memory_copy', 'memory_move');

-- ---- Built-in text --------------------------------------------------------

-- The built-in "schemas and data" skill told the model to use memory notes
-- for loose facts (0018). The current record and its current version both
-- change.
UPDATE skills
  SET body = replace(
    body,
    'Use files for writing kept for the user, and memory notes for loose facts.',
    'Use files for writing kept for the user.'
  )
  WHERE id = 'builtin-schemas-and-data' AND builtin = 1;
UPDATE skill_versions
  SET body = replace(
    body,
    'Use files for writing kept for the user, and memory notes for loose facts.',
    'Use files for writing kept for the user.'
  )
  WHERE skill_id = 'builtin-schemas-and-data'
    AND seq = (SELECT version FROM skills WHERE id = 'builtin-schemas-and-data');
