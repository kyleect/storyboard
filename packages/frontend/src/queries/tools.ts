/*
 * Query keys for tools:
 *
 *   ["tools", "list"]        every tool and its setting (Settings)
 *   ["tools", "selectable"]  the tools an agent can select, by name
 *   ["tools", "approvals"]   every tool's setting, for the agent editor
 */
export const toolKeys = {
  all: ["tools"] as const,
  list: () => [...toolKeys.all, "list"] as const,
  selectable: () => [...toolKeys.all, "selectable"] as const,
  approvals: () => [...toolKeys.all, "approvals"] as const,
};

/** Query keys for MCP servers. */
export const mcpKeys = {
  all: ["mcp-servers"] as const,
  list: () => [...mcpKeys.all, "list"] as const,
};
