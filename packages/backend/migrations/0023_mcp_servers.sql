-- MCP servers (MCP design). Each row is a server the backend connects to as
-- an MCP client; its tools are offered to agents in the "mcp" tool group.
--
-- `name` is the slug in the tools' names (`mcp_<name>_<tool>`), so it is
-- unique and fixed in shape. `transport` is "stdio" (the backend starts a
-- process) or "http" (a remote Streamable HTTP server). `config` holds the
-- transport's settings as JSON: command, args, env and cwd for stdio; url
-- and headers for http. The database is encrypted, so tokens in env or
-- headers are stored like the rest of the data.
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
