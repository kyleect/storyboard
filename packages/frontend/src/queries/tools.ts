export const toolKeys = {
  all: ["tools"] as const,
  list: () => [...toolKeys.all, "list"] as const,
  selectable: () => [...toolKeys.all, "selectable"] as const,
  approvals: () => [...toolKeys.all, "approvals"] as const,
};

export const mcpKeys = {
  all: ["mcp-servers"] as const,
  list: () => [...mcpKeys.all, "list"] as const,
};
