-- Workspaces and .gitignore, and what each scope can see (workspace
-- visibility design).
--
-- respect_gitignore: files a folder's .gitignore files ignore are not scanned
-- for search and are not shown to the helper. On for every workspace, so a
-- workspace that is a git repository stops showing its build output and
-- dependencies; it can be turned off per workspace.
ALTER TABLE workspaces ADD COLUMN respect_gitignore INTEGER NOT NULL DEFAULT 1;

-- Paths a scope hides from the sessions it covers. A hidden folder hides what
-- is inside it. Nothing hidden is the default, and a new file is visible.
-- scope_id is '' for global. It is not a foreign key because it names a
-- project or a session depending on scope_kind; a purge removes its rows.
CREATE TABLE workspace_hidden (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'session')),
  scope_id     TEXT NOT NULL DEFAULT '',
  path         TEXT NOT NULL,
  PRIMARY KEY (workspace_id, scope_kind, scope_id, path)
);
