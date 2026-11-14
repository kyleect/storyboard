import { useQuery } from "@tanstack/react-query";
import { api, type UnreadSession } from "../api";
import { unreadKeys } from "../queries";

export interface UnreadSessions {
  sessions: readonly UnreadSession[];
  ids: ReadonlySet<string>;
  count: number;
}

const NONE: UnreadSessions = { sessions: [], ids: new Set(), count: 0 };

const select = (data: { sessions: UnreadSession[] }): UnreadSessions => ({
  sessions: data.sessions,
  ids: new Set(data.sessions.map((s) => s.id)),
  count: data.sessions.length,
});

export function useUnreadSessions(): UnreadSessions {
  const { data } = useQuery({
    queryKey: unreadKeys.sessions(),
    queryFn: api.listUnreadSessions,
    select,
  });
  return data ?? NONE;
}
