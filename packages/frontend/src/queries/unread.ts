import { sessionKeys } from "./sessions";

export const unreadKeys = {
  sessions: () => [...sessionKeys.lists(), "unread"] as const,
};
