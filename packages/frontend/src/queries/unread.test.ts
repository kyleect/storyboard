import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { sessionKeys, unreadKeys } from "./index";

type Keys = Record<string, readonly unknown[]>;

/** The names of the queries that invalidating `prefix` marks stale. */
async function reach(prefix: readonly unknown[], keys: Keys) {
  const client = new QueryClient();

  for (const key of Object.values(keys)) client.setQueryData(key, "cached");

  await client.invalidateQueries({ queryKey: prefix, refetchType: "none" });

  return Object.entries(keys)
    .filter(([, key]) => client.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();
}

describe("unread keys", () => {
  const keys: Keys = {
    listOfProject: sessionKeys.list("p1"),
    page: sessionKeys.page({
      projectId: null,
      direction: "desc",
      page: 1,
      pageSize: 10,
    }),
    detail: sessionKeys.detail("s1"),
    unread: unreadKeys.sessions(),
  };

  it("are refreshed with the session lists", async () => {
    expect(await reach(sessionKeys.lists(), keys)).toEqual([
      "listOfProject",
      "page",
      "unread",
    ]);
  });

  it("are not reached by one project's list, the pages, or a session's detail", async () => {
    expect(await reach(sessionKeys.list("p1"), keys)).toEqual([
      "listOfProject",
    ]);
    expect(await reach(sessionKeys.pages(), keys)).toEqual(["page"]);
    expect(await reach(sessionKeys.details(), keys)).toEqual(["detail"]);
  });

  it("can be refreshed alone", async () => {
    expect(await reach(unreadKeys.sessions(), keys)).toEqual(["unread"]);
  });
});
