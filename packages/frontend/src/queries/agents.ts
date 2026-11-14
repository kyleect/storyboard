import type { AgentScope } from "../api";
import { scopeKey } from "./scope";

export const agentKeys = {
  all: ["agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  scopeLists: (scope: AgentScope) =>
    [...agentKeys.lists(), scopeKey(scope)] as const,
  list: (scope: AgentScope, showDeleted: boolean) =>
    [...agentKeys.scopeLists(scope), { showDeleted }] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
  version: (id: string, version: number) =>
    [...agentKeys.all, "version", id, version] as const,
  copyTargets: (scope: AgentScope) =>
    [...agentKeys.all, "copy-targets", scopeKey(scope)] as const,
};
