import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { unreadKeys } from "./queries";

/*
 * Which sessions have a reply the user has not seen, in any project. The data
 * is the backend's `GET /api/sessions-unread/ids`. It is server data, so it
 * lives in the query cache; its key is part of `sessionKeys.lists()`, so it is
 * refetched when a run ends, when a chat is opened and marked seen, and
 * whenever the app-wide stream opens (see `useAppEvents`).
 *
 * The open tabs use it, since a tab may belong to a project the chats tree
 * has not opened. A table of chats already has `unread` on each row.
 */

export interface UnreadSessions {
  /** The ids of the sessions with a reply not yet seen. */
  ids: ReadonlySet<string>;
  /** How many there are. */
  count: number;
}

/** What the hook returns until the first answer arrives. */
const NONE: UnreadSessions = { ids: new Set(), count: 0 };

const select = (data: { ids: string[] }): UnreadSessions => ({
  ids: new Set(data.ids),
  count: data.ids.length,
});

export function useUnreadSessions(): UnreadSessions {
  const { data } = useQuery({
    queryKey: unreadKeys.sessions(),
    queryFn: api.listUnreadSessions,
    select,
  });
  return data ?? NONE;
}
