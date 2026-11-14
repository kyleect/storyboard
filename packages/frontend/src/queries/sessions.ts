import type { SessionPageQuery } from "../api";

export const sessionKeys = {
  all: ["sessions"] as const,
  lists: () => [...sessionKeys.all, "list"] as const,
  list: (projectId: string | null) =>
    [...sessionKeys.lists(), { projectId }] as const,
  unreadCount: () => [...sessionKeys.lists(), "unread-count"] as const,
  pages: () => [...sessionKeys.lists(), "page"] as const,
  page: (query: SessionPageQuery) => [...sessionKeys.pages(), query] as const,
  details: () => [...sessionKeys.all, "detail"] as const,
  detail: (id: string) => [...sessionKeys.details(), id] as const,
  debug: (id: string) => [...sessionKeys.all, "debug", id] as const,
  mediaChoices: (id: string) =>
    [...sessionKeys.all, "media-choices", id] as const,
  pickableAgents: () => [...sessionKeys.all, "agents"] as const,
  pickableAgentsFor: (id: string) =>
    [...sessionKeys.pickableAgents(), id] as const,
};

export const trashKeys = {
  all: ["trash"] as const,
};
