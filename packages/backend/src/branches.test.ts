import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@harness/core";
import { putBlob, sweepBlobs } from "./blobs.js";
import { fileLookup } from "./file-lookup.js";
import { reindexBlob } from "./media-describer.js";
import { SearchIndex } from "./search-index.js";
import { buildSessionDebug } from "./session-debug.js";
import { Store } from "./store.js";
import { activeMessageJson } from "./transcript.js";
import { tempDatabase, type TempDatabase } from "./test-helpers.js";

/* Message branches: storage and reading (message editing plan, part A). */

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const user = (content: string): Message => ({ role: "user", content });
const asst = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const call = (callId: string, name = "start_subagent"): Message => ({
  role: "assistant",
  content: [{ type: "tool_call", callId, name, arguments: {} }],
});

function setup() {
  temp = tempDatabase();
  const store = new Store(temp.db);
  store.createSession("s", "Session", "T0");
  let n = 0;
  const add = (id: string, message: Message, anchorId: string | null = null) =>
    store.addMessage(
      "s",
      id,
      message,
      `T${++n}`,
      undefined,
      undefined,
      anchorId,
    );
  const ids = (only?: "top") => store.listMessages("s", only).map((m) => m.id);
  const db = temp.db;
  const row = (id: string) =>
    db
      .prepare(
        "SELECT parent_id, anchor_id, last_child_id, trashed_at FROM messages WHERE id = ?",
      )
      .get(id) as {
      parent_id: string | null;
      anchor_id: string | null;
      last_child_id: string | null;
      trashed_at: string | null;
    };
  const tip = () => store.getSession("s")?.tip_id;
  return { db: temp.db, store, add, ids, row, tip };
}

/** u1 -> a1 -> u2 -> a2, with u1b -> a1b as another branch from the start. */
function twoBranches() {
  const t = setup();
  t.add("u1", user("one"));
  t.add("a1", asst("answer one"));
  t.add("u2", user("two"));
  t.add("a2", asst("answer two"));
  // The edit of u1: a sibling, then its own reply.
  t.store.addMessageAfter("s", null, "u1b", user("one, edited"), "T9");
  t.store.moveTip("s", "u1b");
  t.add("a1b", asst("answer one b"));
  return t;
}

describe("addMessage and saveMessage", () => {
  it("chains messages into one line and moves the tip", () => {
    const t = setup();
    expect(t.tip()).toBeNull();
    t.add("u1", user("hi"));
    t.add("a1", asst("hello"));
    t.add("u2", user("more"));
    expect(t.row("u1")).toMatchObject({ parent_id: null, last_child_id: "a1" });
    expect(t.row("a1")).toMatchObject({ parent_id: "u1", last_child_id: "u2" });
    expect(t.row("u2")).toMatchObject({ parent_id: "a1" });
    expect(t.tip()).toBe("u2");
    expect(t.ids()).toEqual(["u1", "a1", "u2"]);
  });

  it("changes no pointer when it replaces a message (a continued reply)", () => {
    const t = setup();
    t.add("u1", user("hi"));
    t.add("a1", asst("hel"));
    t.store.saveMessage("s", "a1", asst("hello"), "T9");
    expect(t.tip()).toBe("a1");
    expect(t.row("a1").parent_id).toBe("u1");
    expect(t.store.getMessage("a1")).toEqual(asst("hello"));
  });

  it("leaves the tip alone for a subagent's message, which has no parent", () => {
    const t = setup();
    t.add("u1", user("go"));
    t.add("a1", call("c1"));
    t.add("child1", user("task"), "a1");
    expect(t.tip()).toBe("a1");
    expect(t.row("child1")).toMatchObject({ parent_id: null, anchor_id: "a1" });
    expect(t.row("a1").last_child_id).toBeNull();
    t.add("t1", {
      role: "tool",
      callId: "c1",
      name: "x",
      content: "ok",
      isError: false,
    });
    expect(t.row("t1").parent_id).toBe("a1");
  });
});

describe("listMessages", () => {
  it("shows the line and the subagent messages anchored to it", () => {
    const t = setup();
    t.add("u1", user("go"));
    t.add("a1", call("c1"));
    t.add("c-task", user("task"), "a1");
    t.add("c-a", asst("done"), "a1");
    t.add("t1", {
      role: "tool",
      callId: "c1",
      name: "x",
      content: "ok",
      isError: false,
    });
    expect(t.ids()).toEqual(["u1", "a1", "c-task", "c-a", "t1"]);
    expect(t.ids("top")).toEqual(["u1", "a1", "t1"]);
  });

  it("shows only the line the tip is on, and is read again after a move", () => {
    const t = twoBranches();
    expect(t.ids()).toEqual(["u1b", "a1b"]);
    t.store.moveTip("s", "a2");
    expect(t.ids()).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps seq in conversation order along each line after a branch", () => {
    const t = twoBranches();
    const seq = (id: string) =>
      (
        t.db.prepare("SELECT seq FROM messages WHERE id = ?").get(id) as {
          seq: number;
        }
      ).seq;
    // The new branch was inserted last, so it has the larger seq; along each
    // line the seq still increases.
    expect(seq("u1b")).toBeGreaterThan(seq("a2"));
    for (const line of [
      ["u1", "a1", "u2", "a2"],
      ["u1b", "a1b"],
    ]) {
      const seqs = line.map(seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it("reports live siblings with their place, in creation order", () => {
    const t = twoBranches();
    const [u1b] = t.store.listMessages("s");
    expect(u1b?.parentId).toBeNull();
    expect(u1b?.branches).toEqual({ ids: ["u1", "u1b"], index: 1 });
    t.store.moveTip("s", "a2");
    const first = t.store.listMessages("s")[0];
    expect(first?.branches).toEqual({ ids: ["u1", "u1b"], index: 0 });
    // A message with no sibling has none.
    expect(t.store.listMessages("s")[1]?.branches).toBeNull();
  });

  it("does not count a deleted branch among the siblings", () => {
    const t = twoBranches();
    t.store.trashBranch("u1", "T20");
    expect(t.store.siblings("u1b")).toEqual(["u1b"]);
    expect(t.store.listMessages("s")[0]?.branches).toBeNull();
  });

  it("lists the messages a run wrote, whatever line they are on", () => {
    const t = twoBranches();
    t.store.createRun({
      id: "r1",
      sessionId: "s",
      kind: "chat",
      now: "T30",
    });
    t.store.linkRunMessage("r1", "a2");
    expect(t.store.listMessages("s", { run: "r1" }).map((m) => m.id)).toEqual([
      "a2",
    ]);
  });

  it("lists every branch with where each message sits for the debug export", () => {
    const t = twoBranches();
    t.store.trashBranch("u1", "T20");
    const all = t.store.listMessages("s", "all");
    expect(all.map((m) => [m.id, m.active, m.trashed, m.parentId])).toEqual([
      ["u1", false, true, null],
      ["a1", false, true, "u1"],
      ["u2", false, true, "a1"],
      ["a2", false, true, "u2"],
      ["u1b", true, false, null],
      ["a1b", true, false, "u1b"],
    ]);
    const session = t.store.getSession("s");
    if (!session) throw new Error("no session");
    const debug = buildSessionDebug(t.store, session, "now");
    expect(debug.format).toBe(2);
    expect(debug.messages).toHaveLength(6);
    expect(debug.messages[0]).toMatchObject({ id: "u1", active: false });
  });
});

describe("moving through the tree", () => {
  it("orders siblings by creation, not by when they were last used", () => {
    const t = twoBranches();
    expect(t.store.siblings("u1")).toEqual(["u1", "u1b"]);
    expect(t.store.siblings("u1b")).toEqual(["u1", "u1b"]);
    // A message with an anchor has no siblings.
    expect(t.store.siblings("nope")).toEqual([]);
  });

  it("follows the continuation last viewed, else the newest", () => {
    const t = twoBranches();
    // moveTip remembered the line a1b ended; u1b's last child is a1b.
    expect(t.store.descend("u1b")).toBe("a1b");
    // u1 was left on the way to a2: its last child chain is a1, u2, a2.
    expect(t.store.descend("u1")).toBe("a2");
    // With no hint, the newest live child wins.
    t.db.prepare("UPDATE messages SET last_child_id = NULL").run();
    t.store.addMessageAfter("s", "a1", "u2b", user("two, again"), "T40");
    expect(t.store.descend("a1")).toBe("u2b");
    expect(t.store.descend("u1")).toBe("u2b");
  });

  it("skips a hint that points at a deleted child", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a2");
    t.store.addMessageAfter("s", "a1", "u2b", user("two, again"), "T40");
    t.store.trashBranch("u2", "T41");
    expect(t.store.descend("a1")).toBe("u2b");
  });

  it("sets each message on the new line to name the next one", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a2");
    expect(t.row("u1").last_child_id).toBe("a1");
    expect(t.row("a1").last_child_id).toBe("u2");
    expect(t.row("u2").last_child_id).toBe("a2");
    expect(t.store.lineIds("a2")).toEqual(["u1", "a1", "u2", "a2"]);
    expect(t.tip()).toBe("a2");
  });

  it("lists the live children of a message", () => {
    const t = twoBranches();
    t.store.addMessageAfter("s", "a1", "u2b", user("two, again"), "T40");
    expect(t.store.children("a1")).toEqual(["u2", "u2b"]);
  });
});

describe("anchorFor", () => {
  function withChildren() {
    const t = setup();
    t.add("u1", user("go"));
    t.add("a1", call("c1"));
    t.store.createRun({ id: "r1", sessionId: "s", kind: "chat", now: "T20" });
    t.store.linkRunMessage("r1", "u1");
    t.store.linkRunMessage("r1", "a1");
    return t;
  }

  it("finds the message that holds the call in a top-level run", () => {
    const t = withChildren();
    expect(t.store.anchorFor("r1", "c1")).toBe("a1");
  });

  it("returns the anchor of a subagent run when the parent is one", () => {
    const t = withChildren();
    t.store.createRun({
      id: "r2",
      sessionId: "s",
      kind: "chat",
      now: "T21",
      parent: { runId: "r1", callId: "c1" },
    });
    t.add("child-call", call("c2"), "a1");
    t.store.linkRunMessage("r2", "child-call");
    expect(t.store.anchorFor("r2", "c2")).toBe("a1");
  });

  it("falls back to the parent run's latest message when the call is missing", () => {
    const t = withChildren();
    expect(t.store.anchorFor("r1", "missing")).toBe("a1");
  });
});

describe("deleting branches", () => {
  it("lists a deleted branch once, with its size and first line", () => {
    const t = twoBranches();
    t.store.trashBranch("u1", "T20");
    expect(t.store.listTrashedBranches()).toEqual([
      {
        messageId: "u1",
        sessionId: "s",
        sessionTitle: "Session",
        preview: "one",
        trashedAt: "T20",
        messages: 4,
      },
    ]);
  });

  it("lists a nested deleted branch only with its outer one", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a2");
    t.store.addMessageAfter("s", "a1", "u2b", user("two, again"), "T40");
    t.store.trashBranch("u2b", "T41");
    t.store.trashBranch("u1", "T42");
    expect(t.store.listTrashedBranches().map((b) => b.messageId)).toEqual([
      "u1",
    ]);
    // Restoring the outer one brings the nested one back as still deleted.
    t.store.restoreBranch("u1");
    expect(t.store.listTrashedBranches().map((b) => b.messageId)).toEqual([
      "u2b",
    ]);
  });

  it("does not list branches of a session in the trash", () => {
    const t = twoBranches();
    t.store.trashBranch("u1", "T20");
    t.store.setSessionTrashed("s", "T21");
    expect(t.store.listTrashedBranches()).toEqual([]);
  });

  it("purges a branch with everything under it, and the runs that wrote only that", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a1b");
    for (const [id, message] of [
      ["r-old", "a2"],
      ["r-new", "a1b"],
    ] as const) {
      t.store.createRun({ id, sessionId: "s", kind: "chat", now: "T50" });
      t.store.linkRunMessage(id, message);
      t.store.insertEvent({
        runId: id,
        sessionId: "s",
        time: "T50",
        type: "run.finished",
        data: { reason: "stop" },
      } as never);
    }
    t.store.trashBranch("u1", "T51");
    expect(t.store.purgeTrashedBranches()).toEqual(["u1"]);
    expect(t.ids()).toEqual(["u1b", "a1b"]);
    expect(t.db.prepare("SELECT id FROM messages ORDER BY seq").all()).toEqual([
      { id: "u1b" },
      { id: "a1b" },
    ]);
    expect(t.db.prepare("SELECT id FROM runs").all()).toEqual([
      { id: "r-new" },
    ]);
    expect(t.db.prepare("SELECT DISTINCT run_id FROM events").all()).toEqual([
      { run_id: "r-new" },
    ]);
  });

  it("deletes subagent runs and messages anchored under a purged branch", () => {
    const t = setup();
    t.add("u1", user("go"));
    t.add("a1", call("c1"));
    t.add("c-task", user("task"), "a1");
    t.add("t1", {
      role: "tool",
      callId: "c1",
      name: "x",
      content: "ok",
      isError: false,
    });
    t.store.createRun({ id: "r1", sessionId: "s", kind: "chat", now: "T20" });
    for (const m of ["a1", "t1"]) t.store.linkRunMessage("r1", m);
    t.store.createRun({
      id: "r2",
      sessionId: "s",
      kind: "chat",
      now: "T21",
      parent: { runId: "r1", callId: "c1" },
    });
    t.store.linkRunMessage("r2", "c-task");
    // A sibling to keep the session, then delete the branch from a1.
    t.store.addMessageAfter("s", "u1", "a1b", asst("other"), "T30");
    t.store.moveTip("s", "a1b");
    t.store.trashBranch("a1", "T31");
    t.store.purgeTrashedBranches();
    expect(t.db.prepare("SELECT id FROM messages ORDER BY seq").all()).toEqual([
      { id: "u1" },
      { id: "a1b" },
    ]);
    expect(t.db.prepare("SELECT id FROM runs").all()).toEqual([]);
    expect(t.row("u1").last_child_id).toBe("a1b");
  });

  it("purges only the branches deleted before a date", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a2");
    t.store.addMessageAfter("s", "a1", "u2b", user("two, again"), "T40");
    t.store.trashBranch("u2b", "2026-01-01T00:00:00.000Z");
    t.store.trashBranch("u1b", "2026-06-01T00:00:00.000Z");
    expect(t.store.purgeTrashedBranches("2026-03-01T00:00:00.000Z")).toEqual([
      "u2b",
    ]);
    expect(t.row("u1b").trashed_at).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("purgeSession with branches", () => {
  it("deletes a session whose messages point at each other and at its tip", () => {
    const t = twoBranches();
    t.store.moveTip("s", "a2");
    t.store.purgeSession("s");
    expect(t.db.prepare("SELECT count(*) AS n FROM messages").get()).toEqual({
      n: 0,
    });
    expect(t.store.getSession("s")).toBeUndefined();
  });

  it("keeps the blobs of a branch that is not shown", () => {
    const t = twoBranches();
    const blob = putBlob(t.db, "image/png", Buffer.from("png bytes"), "T");
    t.store.addMessageAfter(
      "s",
      "a1",
      "edit-old",
      {
        role: "edit",
        content: "added a file",
        entries: [
          {
            op: "put",
            kind: "file",
            key: "cat.png",
            value: "",
            mediaType: "image/png",
            blob,
          },
        ],
      } as Message,
      "T60",
    );
    // The line shown is the other branch; the blob is still named.
    expect(t.store.getSession("s")?.tip_id).toBe("a1b");
    sweepBlobs(t.db);
    expect(
      t.db.prepare("SELECT hash FROM blobs WHERE hash = ?").get(blob.hash),
    ).toBeDefined();
  });
});

describe("the other readers", () => {
  it("takes the usage of the nearest message on the line, not another branch", () => {
    const t = setup();
    t.add("u1", user("a"));
    t.store.addMessage("s", "a1", asst("one"), "T5", undefined, {
      promptTokens: 10,
      completionTokens: 1,
    });
    t.add("u2", user("b"));
    t.store.addMessageAfter("s", "u1", "a1b", asst("other"), "T6");
    t.db
      .prepare("UPDATE messages SET usage = ? WHERE id = 'a1b'")
      .run(JSON.stringify({ promptTokens: 99, completionTokens: 9 }));
    // The line is u1, a1, u2; a1b is newer by seq but on another branch.
    expect(t.store.listSessions()[0]?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 1,
    });
    t.store.moveTip("s", "a1b");
    expect(t.store.listSessions()[0]?.usage).toEqual({
      promptTokens: 99,
      completionTokens: 9,
    });
  });

  it("reads the transcript for the search index from the line only", () => {
    const t = twoBranches();
    expect(
      activeMessageJson(t.db, "s").map((j) => (JSON.parse(j) as Message).role),
    ).toEqual(["user", "assistant"]);
    t.store.moveTip("s", "a2");
    expect(activeMessageJson(t.db, "s")).toHaveLength(4);
  });

  it("indexes the files of the line shown, and again after a switch", () => {
    const t = setup();
    t.add("u1", user("hi"));
    const put = (key: string): Message =>
      ({
        role: "edit",
        content: `added ${key}`,
        entries: [
          {
            op: "put",
            kind: "file",
            key,
            value: `text of ${key}`,
            mediaType: "text/plain",
          },
        ],
      }) as Message;
    t.add("e-a", put("a.txt"));
    t.store.addMessageAfter("s", "u1", "e-b", put("b.txt"), "T9");
    const index = new SearchIndex(t.db);
    const keys = () =>
      (
        t.db
          .prepare(
            "SELECT DISTINCT key FROM chunks WHERE scope = 'session' AND owner_id = 's' ORDER BY key",
          )
          .all() as { key: string }[]
      ).map((r) => r.key);
    index.reindexSession("s");
    expect(keys()).toEqual(["a.txt"]);
    t.store.moveTip("s", "e-b");
    index.reindexSession("s");
    expect(keys()).toEqual(["b.txt"]);
  });

  it("rebuilds the whole index from the line shown, not every branch", () => {
    const t = setup();
    t.add("u1", user("hi"));
    const put = (key: string): Message =>
      ({
        role: "edit",
        content: `added ${key}`,
        entries: [
          {
            op: "put",
            kind: "file",
            key,
            value: `text of ${key}`,
            mediaType: "text/plain",
          },
        ],
      }) as Message;
    t.add("e-a", put("a.txt"));
    t.store.addMessageAfter("s", "u1", "e-b", put("b.txt"), "T9");
    new SearchIndex(t.db).buildIfNeeded();
    const keys = (
      t.db
        .prepare("SELECT DISTINCT key FROM chunks WHERE scope = 'session'")
        .all() as { key: string }[]
    ).map((r) => r.key);
    expect(keys).toEqual(["a.txt"]);
  });

  it("looks up session files in the line shown, and again after a switch", () => {
    const t = setup();
    t.add("u1", user("hi"));
    const put = (key: string): Message =>
      ({
        role: "edit",
        content: `added ${key}`,
        entries: [
          {
            op: "put",
            kind: "file",
            key,
            value: `text of ${key}`,
            mediaType: "text/plain",
          },
        ],
      }) as Message;
    t.add("e-a", put("a.txt"));
    t.store.addMessageAfter("s", "u1", "e-b", put("b.txt"), "T9");
    const find = fileLookup(t.store, undefined, "s");
    expect(find("session://a.txt")).toBeDefined();
    expect(find("session://b.txt")).toBeUndefined();
    // No message was added or removed, only the tip moved.
    t.store.moveTip("s", "e-b");
    expect(find("session://a.txt")).toBeUndefined();
    expect(find("session://b.txt")).toBeDefined();
  });

  it("indexes the text of a described file only for the line shown", () => {
    const t = setup();
    t.add("u1", user("hi"));
    const blob = putBlob(t.db, "image/png", Buffer.from("png bytes"), "T");
    t.db
      .prepare(
        "UPDATE blobs SET derived_text = 'a cat on a sofa', derived_state = 'generated' WHERE hash = ?",
      )
      .run(blob.hash);
    const attach = (key: string): Message =>
      ({
        role: "edit",
        content: `added ${key}`,
        entries: [
          {
            op: "put",
            kind: "file",
            key,
            value: "",
            mediaType: "image/png",
            blob,
          },
        ],
      }) as Message;
    t.add("e-a", attach("shown.png"));
    t.store.addMessageAfter("s", "u1", "e-b", attach("hidden.png"), "T9");
    reindexBlob(t.db, new SearchIndex(t.db), blob.hash);
    expect(
      (
        t.db
          .prepare(
            "SELECT DISTINCT key FROM chunks WHERE scope = 'session' AND owner_id = 's'",
          )
          .all() as { key: string }[]
      ).map((r) => r.key),
    ).toEqual(["shown.png"]);
  });
});
