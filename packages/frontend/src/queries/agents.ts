import type { AgentScope } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for agents:
 *
 *   ["agents", "list", { scope, id }, { showDeleted }]
 *   ["agents", "detail", id]
 *   ["agents", "version", id, version]
 *   ["agents", "copy-targets", { scope, id }]
 *
 * An agent is fetched by id alone, so details are not under a scope.
 */
export const agentKeys = {
  all: ["agents"] as const,
  lists: () => [...agentKeys.all, "list"] as const,
  /** Every list of one scope's agents, deleted ones shown or not. */
  scopeLists: (scope: AgentScope) =>
    [...agentKeys.lists(), scopeKey(scope)] as const,
  list: (scope: AgentScope, showDeleted: boolean) =>
    [...agentKeys.scopeLists(scope), { showDeleted }] as const,
  details: () => [...agentKeys.all, "detail"] as const,
  detail: (id: string) => [...agentKeys.details(), id] as const,
  /** Versions never change, so these are fetched once. */
  version: (id: string, version: number) =>
    [...agentKeys.all, "version", id, version] as const,
  /** The agents of a scope, as places to copy a schema to. */
  copyTargets: (scope: AgentScope) =>
    [...agentKeys.all, "copy-targets", scopeKey(scope)] as const,
};
