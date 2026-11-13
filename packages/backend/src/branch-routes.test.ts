import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  type ChatRequest,
  type Message,
  type ScriptStep,
  type StoredEvent,
} from "@harness/core";
import { AppEvents } from "./app-events.js";
import { completePoints, regenerableTurn } from "./branches.js";
import { RunManager } from "./runs.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store, type StoredMessage } from "./store.js";
import { clearBuiltinAgents, tempDatabase } from "./test-helpers.js";

/* Editing, regenerating, branching, switching and deleting (message editing
 * plan, part B). */

const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const say = (text: string): ScriptStep[] => [
  { type: "text", text },
  { type: "finish", reason: "stop" },
];

async function setup(
  scripts: ScriptStep[][] = [],
  settings: Record<string, unknown> = {},
) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: [],
    systemPrompt: () => "BASE",
    now,
  });
  const app = buildServer({
    store,
    runs,
    events: new AppEvents(),
    token: TOKEN,
    env: {},
    now,
    keepaliveMs: 60_000,
  });
  cleanups.push(t.cleanup, () => app.close());
  const events: StoredEvent[] = [];
  const watch = (sessionId: string) => {
    const off = runs.subscribe(sessionId, (e) => events.push(e));
    cleanups.push(off);
  };
  return { t, store, runs, app, model, events, watch };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** The chat request the model was sent for its `n`th call; -1: the last. */
const request = (c: Setup, n: number) =>
  c.model.requests.at(n) as ChatRequest | undefined;

async function api(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return {
    status: res.statusCode,
    body: (res.body === "" ? undefined : JSON.parse(res.body)) as Record<
      string,
      unknown
    > &
      Record<number, unknown>,
  };
}

async function newSession(c: Setup) {
  const { body } = await api(c.app, "POST", "/api/sessions", {});
  const id = body.id as string;
  c.watch(id);
  return id;
}

async function settle(c: Setup, runId: unknown) {
  await expect.poll(() => c.runs.isActive(runId as string)).toBe(false);
}

/** Sends a message and waits for the reply. */
async function send(c: Setup, id: string, content: string) {
  const res = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
    content,
  });
  expect(res.status).toBe(202);
  await settle(c, res.body.runId);
}

interface View {
  messages: (StoredMessage & { message: Message })[];
  branching: {
    points: string[];
    editable: string[];
    regenerate: string | null;
    continuations: { id: string; role: string; preview: string }[];
  };
  session: { tip_id: string | null };
}

async function view(c: Setup, id: string): Promise<View> {
  const { body } = await api(c.app, "GET", `/api/sessions/${id}`);
  return body as unknown as View;
}

const text = (m: StoredMessage): string => {
  const message = m.message;
  if (message.role === "user") return message.content;
  if (message.role === "assistant")
    return message.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("");
  return "";
};

const texts = async (c: Setup, id: string) =>
  (await view(c, id)).messages.map(text);

describe("PATCH /api/sessions/:id/messages/:messageId (edit)", () => {
  it("makes a branch, moves the line to the edited copy and answers it", async () => {
    const c = await setup([say("one"), say("fixed answer")]);
    const id = await newSession(c);
    await send(c, id, "wrong");
    const first = (await view(c, id)).messages[0] as StoredMessage;

    const res = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "right" },
    );
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ mode: "branch" });
    await settle(c, res.body.runId);

    expect(await texts(c, id)).toEqual(["right", "fixed answer"]);
    // The model was sent the edited text and none of the old reply.
    const sent = request(c, -1)?.messages.map((m) => m.content);
    expect(sent).toEqual(["BASE", "right"]);
    // The first message now has a sibling, the copy being the second.
    const shown = (await view(c, id)).messages[0] as StoredMessage;
    expect(shown.id).not.toBe(first.id);
    expect(shown.branches).toEqual({ ids: [first.id, shown.id], index: 1 });
    expect(shown.parentId).toBeNull();

    // The old branch is intact and switchable.
    const back = await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: first.id,
    });
    expect(back.status).toBe(200);
    expect(await texts(c, id)).toEqual(["wrong", "one"]);
  });

  it("edits a message in the middle of the line; what followed stays as a branch", async () => {
    const c = await setup([say("a1"), say("a2"), say("a2 again")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const [, , q2] = (await view(c, id)).messages;

    const res = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${q2?.id}`,
      { content: "q2 edited" },
    );
    await settle(c, res.body.runId);
    expect(await texts(c, id)).toEqual(["q1", "a1", "q2 edited", "a2 again"]);
    const copy = (await view(c, id)).messages[2] as StoredMessage;
    expect(copy.parentId).toBe(q2?.parentId);
    expect(copy.branches?.ids).toHaveLength(2);
  });

  it("overwrites the text in place, keeps what follows and does not run the model", async () => {
    const c = await setup([say("one")]);
    const id = await newSession(c);
    await send(c, id, "wrong");
    const before = await view(c, id);
    const first = before.messages[0] as StoredMessage;
    const calls = c.model.requests.length;

    const res = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "right", mode: "in_place" },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      messageId: first.id,
      mode: "in_place",
      runId: null,
    });
    expect(c.model.requests).toHaveLength(calls);
    const after = await view(c, id);
    expect(after.messages.map(text)).toEqual(["right", "one"]);
    expect(after.messages[0]?.id).toBe(first.id);
    expect(after.messages[0]?.branches).toBeNull();
    expect(after.session.tip_id).toBe(before.session.tip_id);
    expect(c.events.at(-1)).toMatchObject({
      type: "session.transcript_changed",
      data: { reason: "edit", messageId: first.id },
    });
  });

  it("follows the editMode setting, and a request can choose the other mode", async () => {
    const c = await setup([say("one"), say("two")], { editMode: "in_place" });
    const id = await newSession(c);
    await send(c, id, "wrong");
    const first = (await view(c, id)).messages[0] as StoredMessage;
    const url = `/api/sessions/${id}/messages/${first.id}`;

    const inPlace = await api(c.app, "PATCH", url, { content: "a" });
    expect(inPlace.body.mode).toBe("in_place");
    expect(c.model.requests).toHaveLength(1);

    const branch = await api(c.app, "PATCH", url, {
      content: "b",
      mode: "branch",
    });
    expect(branch.body.mode).toBe("branch");
    await settle(c, branch.body.runId);
    expect(await texts(c, id)).toEqual(["b", "two"]);
  });

  it("does not answer after a branch edit when answerAfterEdit is off, and Branch off then does", async () => {
    const c = await setup([say("one"), say("answer")], {
      answerAfterEdit: false,
    });
    const id = await newSession(c);
    await send(c, id, "wrong");
    const first = (await view(c, id)).messages[0] as StoredMessage;

    const res = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "right" },
    );
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
    expect(c.model.requests).toHaveLength(1);
    const edited = await view(c, id);
    expect(await texts(c, id)).toEqual(["right"]);
    expect(edited.branching.regenerate).toBeNull();

    const copyId = res.body.messageId as string;
    const answer = await api(c.app, "POST", `/api/sessions/${id}/branch`, {
      messageId: copyId,
    });
    expect(answer.status).toBe(202);
    await settle(c, answer.body.runId);
    expect(await texts(c, id)).toEqual(["right", "answer"]);
  });

  it("branches an edit of the first message into several first messages", async () => {
    const c = await setup([say("one"), say("two"), say("three")]);
    const id = await newSession(c);
    await send(c, id, "v1");
    const v1 = (await view(c, id)).messages[0] as StoredMessage;
    for (const content of ["v2", "v3"]) {
      const current = (await view(c, id)).messages[0] as StoredMessage;
      const res = await api(
        c.app,
        "PATCH",
        `/api/sessions/${id}/messages/${current.id}`,
        { content },
      );
      await settle(c, res.body.runId);
    }
    const shown = (await view(c, id)).messages[0] as StoredMessage;
    expect(shown.branches?.index).toBe(2);
    expect(shown.branches?.ids).toHaveLength(3);
    expect(shown.branches?.ids[0]).toBe(v1.id);
    expect(c.store.siblings(v1.id)).toHaveLength(3);
  });

  it("refuses an empty text, but allows it for a message with files", async () => {
    const c = await setup([say("one")]);
    const id = await newSession(c);
    await send(c, id, "hi");
    const first = (await view(c, id)).messages[0] as StoredMessage;
    const url = `/api/sessions/${id}/messages/${first.id}`;
    expect((await api(c.app, "PATCH", url, { content: "" })).status).toBe(400);

    c.store.replaceMessage(first.id, {
      role: "user",
      content: "hi",
      files: ["session://cat.png"],
    });
    const res = await api(c.app, "PATCH", url, {
      content: "",
      mode: "in_place",
    });
    expect(res.status).toBe(200);
    expect(c.store.getMessage(first.id)).toEqual({
      role: "user",
      content: "",
      files: ["session://cat.png"],
    });
  });

  it("refuses anything but the user's own messages on the line shown", async () => {
    const c = await setup([say("one")]);
    const id = await newSession(c);
    await send(c, id, "hi");
    const [, reply] = (await view(c, id)).messages;
    const edit = (messageId: string) =>
      api(c.app, "PATCH", `/api/sessions/${id}/messages/${messageId}`, {
        content: "x",
      });
    expect((await edit(reply?.id as string)).status).toBe(409);
    expect((await edit("nope")).status).toBe(404);

    // A message of another branch is not on the line shown.
    const first = (await view(c, id)).messages[0] as StoredMessage;
    const res = await api(
      c.app,
      "PATCH",
      `/api/sessions/${id}/messages/${first.id}`,
      { content: "again", mode: "branch" },
    );
    await settle(c, res.body.runId).catch(() => undefined);
    expect((await edit(first.id)).status).toBe(409);
  });
});

describe("POST /api/sessions/:id/regenerate", () => {
  it("answers the turn again and keeps the old reply as a branch", async () => {
    const c = await setup([say("first try"), say("second try")]);
    const id = await newSession(c);
    await send(c, id, "write");
    const before = await view(c, id);
    expect(before.branching.regenerate).toBe(before.messages[0]?.id);

    const res = await api(c.app, "POST", `/api/sessions/${id}/regenerate`);
    expect(res.status).toBe(202);
    await settle(c, res.body.runId);

    const after = await view(c, id);
    expect(after.messages.map(text)).toEqual(["write", "second try"]);
    const reply = after.messages[1] as StoredMessage;
    expect(reply.branches).toEqual({
      ids: [before.messages[1]?.id, reply.id],
      index: 1,
    });
    // The user message has the same id: it was not copied.
    expect(after.messages[0]?.id).toBe(before.messages[0]?.id);
    // The model was sent the same request both times.
    expect(request(c, 1)?.messages).toEqual(request(c, 0)?.messages);
  });

  it("is not offered with no reply, or after the user changed files or data", async () => {
    const c = await setup([say("one")]);
    const id = await newSession(c);
    expect((await view(c, id)).branching.regenerate).toBeNull();
    expect(
      (await api(c.app, "POST", `/api/sessions/${id}/regenerate`)).status,
    ).toBe(409);

    await send(c, id, "hi");
    expect((await view(c, id)).branching.regenerate).not.toBeNull();
    c.runs.editSessionFiles(id, [
      {
        op: "put",
        kind: "file",
        key: "n",
        value: "a file",
      } as never,
    ]);
    expect((await view(c, id)).branching.regenerate).toBeNull();
    expect(
      (await api(c.app, "POST", `/api/sessions/${id}/regenerate`)).status,
    ).toBe(409);
  });
});

describe("POST /api/sessions/:id/branch", () => {
  it("ends the line at an assistant message and waits for the user", async () => {
    const c = await setup([say("a1"), say("a2")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const [, a1] = (await view(c, id)).messages;

    const res = await api(c.app, "POST", `/api/sessions/${id}/branch`, {
      messageId: a1?.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
    const shown = await view(c, id);
    expect(shown.messages.map(text)).toEqual(["q1", "a1"]);
    // What followed is a continuation of the tip, to switch back to.
    expect(shown.branching.continuations).toMatchObject([
      { role: "user", preview: "q2" },
    ]);
    expect(c.events.at(-1)).toMatchObject({
      type: "session.transcript_changed",
      data: { reason: "move", messageId: a1?.id },
    });
  });

  it("answers right away at a user message; the old reply stays as a branch", async () => {
    const c = await setup([say("a1"), say("old reply"), say("new reply")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const [, , q2] = (await view(c, id)).messages;

    const res = await api(c.app, "POST", `/api/sessions/${id}/branch`, {
      messageId: q2?.id,
    });
    expect(res.status).toBe(202);
    await settle(c, res.body.runId);
    const shown = await view(c, id);
    expect(shown.messages.map(text)).toEqual(["q1", "a1", "q2", "new reply"]);
    expect(shown.messages[3]?.branches?.ids).toHaveLength(2);
  });

  it("refuses to start between a tool call and its results, and allows the last result", async () => {
    const c = await setup();
    const id = await newSession(c);
    const add = (messageId: string, message: Message) =>
      c.store.addMessage(id, messageId, message, "T");
    add("u", { role: "user", content: "go" });
    add("a", {
      role: "assistant",
      content: [
        { type: "tool_call", callId: "c1", name: "t", arguments: {} },
        { type: "tool_call", callId: "c2", name: "t", arguments: {} },
      ],
    });
    add("r1", {
      role: "tool",
      callId: "c1",
      name: "t",
      content: "one",
      isError: false,
    });
    add("r2", {
      role: "tool",
      callId: "c2",
      name: "t",
      content: "two",
      isError: false,
    });
    const branch = (messageId: string) =>
      api(c.app, "POST", `/api/sessions/${id}/branch`, { messageId });
    expect((await branch("a")).status).toBe(409);
    expect((await branch("r1")).status).toBe(409);
    expect((await view(c, id)).branching.points).toEqual(["u", "r2"]);
    const ok = await branch("r2");
    expect(ok.status).toBe(200);
    expect(ok.body.runId).toBeNull();
  });
});

describe("POST /api/sessions/:id/switch", () => {
  async function twoReplies() {
    const c = await setup([say("first"), say("second")]);
    const id = await newSession(c);
    await send(c, id, "q");
    const res = await api(c.app, "POST", `/api/sessions/${id}/regenerate`);
    await settle(c, res.body.runId);
    return { c, id };
  }

  it("shows the other branch, and lands on the continuation last viewed", async () => {
    const { c, id } = await twoReplies();
    const [, second] = (await view(c, id)).messages;
    const [firstId] = second?.branches?.ids as string[];
    // A longer continuation on the first branch.
    await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: firstId,
    });
    c.model.requests.length = 0;
    c.runs.editSessionFiles(id, [
      { op: "put", kind: "file", key: "n", value: "x" } as never,
    ]);
    expect((await texts(c, id)).at(0)).toBe("q");

    await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: second?.id,
    });
    expect((await texts(c, id)).slice(0, 2)).toEqual(["q", "second"]);
    // Back to the first, which ended with the user's edit message.
    const back = await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: firstId,
    });
    expect(back.status).toBe(200);
    const shown = await view(c, id);
    expect(shown.messages.map((m) => m.message.role)).toEqual([
      "user",
      "assistant",
      "edit",
    ]);
    expect(back.body.tipId).toBe(shown.messages.at(-1)?.id);
  });

  it("refuses a message that does not follow the line, a deleted branch and another session's", async () => {
    const { c, id } = await twoReplies();
    const [first, second] = c.store
      .listMessages(id, "all")
      .filter((m) => m.message.role === "assistant");
    // A message whose parent is the first reply: not on the line shown.
    c.store.addMessageAfter(
      id,
      first?.id ?? null,
      "deep",
      { role: "user", content: "deeper" },
      "T",
    );
    const switchTo = (messageId: string, session = id) =>
      api(c.app, "POST", `/api/sessions/${session}/switch`, { messageId });
    expect((await switchTo("deep")).status).toBe(409);
    expect((await switchTo("nope")).status).toBe(404);

    // The first reply is not shown; once deleted it cannot be switched to.
    c.store.trashBranch(first?.id ?? "", "T");
    expect((await switchTo(first?.id ?? "")).status).toBe(409);

    // A message of another session is not found.
    const other = await newSession(c);
    expect((await switchTo(second?.id ?? "", other)).status).toBe(404);
    expect((await switchTo(second?.id ?? "")).status).toBe(200);
  });

  it("switches to a continuation after the end of the line", async () => {
    const c = await setup([say("a1"), say("a2")]);
    const id = await newSession(c);
    await send(c, id, "q1");
    await send(c, id, "q2");
    const [, a1] = (await view(c, id)).messages;
    await api(c.app, "POST", `/api/sessions/${id}/branch`, {
      messageId: a1?.id,
    });
    const { continuations } = (await view(c, id)).branching;
    const res = await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: continuations[0]?.id,
    });
    expect(res.status).toBe(200);
    expect(await texts(c, id)).toEqual(["q1", "a1", "q2", "a2"]);
  });
});

describe("DELETE /api/sessions/:id/branches/:messageId", () => {
  async function threeReplies() {
    const c = await setup([say("r1"), say("r2"), say("r3")]);
    const id = await newSession(c);
    await send(c, id, "q");
    for (let i = 0; i < 2; i++) {
      const res = await api(c.app, "POST", `/api/sessions/${id}/regenerate`);
      await settle(c, res.body.runId);
    }
    const ids = ((await view(c, id)).messages[1] as StoredMessage).branches
      ?.ids as string[];
    return { c, id, ids };
  }

  it("switches the line to the previous sibling first when it deletes the branch shown", async () => {
    const { c, id, ids } = await threeReplies();
    const res = await api(
      c.app,
      "DELETE",
      `/api/sessions/${id}/branches/${ids[2]}`,
    );
    expect(res.status).toBe(200);
    expect(await texts(c, id)).toEqual(["q", "r2"]);
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    // The deleted one is not counted.
    expect(reply.branches).toEqual({ ids: [ids[0], ids[1]], index: 1 });
    expect(c.events.at(-1)).toMatchObject({
      type: "session.transcript_changed",
      data: { reason: "delete_branch", messageId: ids[2] },
    });
  });

  it("switches to the next sibling when there is none before", async () => {
    const { c, id, ids } = await threeReplies();
    await api(c.app, "POST", `/api/sessions/${id}/switch`, {
      messageId: ids[0],
    });
    await api(c.app, "DELETE", `/api/sessions/${id}/branches/${ids[0]}`);
    expect(await texts(c, id)).toEqual(["q", "r2"]);
  });

  it("deletes a branch that is not shown without moving the line", async () => {
    const { c, id, ids } = await threeReplies();
    const tip = (await view(c, id)).session.tip_id;
    await api(c.app, "DELETE", `/api/sessions/${id}/branches/${ids[0]}`);
    expect((await view(c, id)).session.tip_id).toBe(tip);
    expect(c.store.siblings(ids[1] as string)).toEqual([ids[1], ids[2]]);
  });

  it("takes everything under it, nested branches included, and restores it", async () => {
    const { c, id, ids } = await threeReplies();
    // A nested branch under the first reply.
    c.store.addMessageAfter(
      id,
      ids[0] ?? null,
      "n1",
      { role: "user", content: "deeper" },
      "T",
    );
    c.store.addMessageAfter(
      id,
      ids[0] ?? null,
      "n2",
      { role: "user", content: "deeper still" },
      "T",
    );
    c.store.trashBranch("n2", "2026-01-01T00:00:00.000Z");
    await api(c.app, "DELETE", `/api/sessions/${id}/branches/${ids[0]}`);

    const trash = (await api(c.app, "GET", "/api/trash")).body;
    expect(trash.branches).toEqual([
      expect.objectContaining({ messageId: ids[0], sessionId: id }),
    ]);
    const restored = await api(
      c.app,
      "POST",
      `/api/trash/branches/${ids[0]}/restore`,
    );
    expect(restored.status).toBe(200);
    // The nested one deleted earlier stays in the trash.
    const after = (await api(c.app, "GET", "/api/trash")).body;
    expect(after.branches).toEqual([
      expect.objectContaining({ messageId: "n2" }),
    ]);
    expect(c.events.at(-1)).toMatchObject({
      type: "session.transcript_changed",
      data: { reason: "restore_branch", messageId: ids[0] },
    });
    expect(c.store.siblings(ids[0] as string)).toHaveLength(3);
  });

  it("refuses to delete the last branch, and one that is already deleted", async () => {
    const c = await setup([say("only")]);
    const id = await newSession(c);
    await send(c, id, "q");
    const [user, reply] = (await view(c, id)).messages;
    for (const message of [user, reply]) {
      expect(
        (
          await api(
            c.app,
            "DELETE",
            `/api/sessions/${id}/branches/${message?.id}`,
          )
        ).status,
      ).toBe(409);
    }
    const { c: d, id: id2, ids } = await threeReplies();
    await api(d.app, "DELETE", `/api/sessions/${id2}/branches/${ids[0]}`);
    expect(
      (await api(d.app, "DELETE", `/api/sessions/${id2}/branches/${ids[0]}`))
        .status,
    ).toBe(409);
    expect(
      (await api(d.app, "DELETE", `/api/sessions/${id2}/branches/nope`)).status,
    ).toBe(404);
  });
});

describe("the Trash and deleted branches", () => {
  it("deletes one branch for good, with its runs, and refuses one not in the trash", async () => {
    const c = await setup([say("r1"), say("r2")]);
    const id = await newSession(c);
    await send(c, id, "q");
    const res = await api(c.app, "POST", `/api/sessions/${id}/regenerate`);
    await settle(c, res.body.runId);
    const [first, second] = ((await view(c, id)).messages[1] as StoredMessage)
      .branches?.ids as string[];

    expect(
      (await api(c.app, "DELETE", `/api/trash/branches/${first}`)).status,
    ).toBe(409);
    await api(c.app, "DELETE", `/api/sessions/${id}/branches/${first}`);
    expect(
      (await api(c.app, "DELETE", `/api/trash/branches/${first}`)).status,
    ).toBe(200);
    expect(c.store.getNode(first as string)).toBeUndefined();
    expect(c.store.getNode(second as string)).toBeDefined();
    // The run that wrote only the deleted reply is gone with it; the run
    // that wrote the other reply stays.
    expect(c.store.listRuns(id).map((r) => r.id)).toEqual([
      c.store.listMessages(id).find((m) => m.id === second)?.runId,
    ]);
    expect(
      (await api(c.app, "DELETE", `/api/trash/branches/${first}`)).status,
    ).toBe(404);
  });

  it("empties with the rest of the trash", async () => {
    const c = await setup([say("r1"), say("r2")]);
    const id = await newSession(c);
    await send(c, id, "q");
    const res = await api(c.app, "POST", `/api/sessions/${id}/regenerate`);
    await settle(c, res.body.runId);
    const [first] = ((await view(c, id)).messages[1] as StoredMessage).branches
      ?.ids as string[];
    await api(c.app, "DELETE", `/api/sessions/${id}/branches/${first}`);
    const emptied = await api(c.app, "DELETE", "/api/trash");
    expect(emptied.body.purged).toEqual({
      projects: 0,
      sessions: 0,
      branches: 1,
    });
    expect((await api(c.app, "GET", "/api/trash")).body.branches).toEqual([]);
  });
});

describe("only when the session is idle", () => {
  it("refuses every operation during a run and in a trashed session", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const c = await setup([
      say("one"),
      [{ type: "wait", until: gate }, ...say("slow")],
    ]);
    const id = await newSession(c);
    await send(c, id, "q");
    const reply = (await view(c, id)).messages[1] as StoredMessage;
    const first = (await view(c, id)).messages[0] as StoredMessage;

    const all = () =>
      Promise.all([
        api(c.app, "PATCH", `/api/sessions/${id}/messages/${first.id}`, {
          content: "x",
        }),
        api(c.app, "POST", `/api/sessions/${id}/regenerate`),
        api(c.app, "POST", `/api/sessions/${id}/branch`, {
          messageId: first.id,
        }),
        api(c.app, "POST", `/api/sessions/${id}/switch`, {
          messageId: reply.id,
        }),
        api(c.app, "DELETE", `/api/sessions/${id}/branches/${reply.id}`),
      ]);

    const running = await api(c.app, "POST", `/api/sessions/${id}/messages`, {
      content: "again",
    });
    expect((await all()).map((r) => r.status)).toEqual([
      409, 409, 409, 409, 409,
    ]);
    release();
    await settle(c, running.body.runId);

    await api(c.app, "POST", `/api/sessions/${id}/trash`);
    expect((await all()).map((r) => r.status)).toEqual([
      409, 409, 409, 409, 409,
    ]);
  });
});

describe("the edit settings", () => {
  it("are stored, validated and read back", async () => {
    const c = await setup();
    expect((await api(c.app, "GET", "/api/settings")).body).toMatchObject({
      effective: { editMode: "branch", answerAfterEdit: true },
    });
    const put = await api(c.app, "PUT", "/api/settings", {
      editMode: "in_place",
      answerAfterEdit: false,
    });
    expect(put.status).toBe(200);
    expect((await api(c.app, "GET", "/api/settings")).body).toMatchObject({
      effective: { editMode: "in_place", answerAfterEdit: false },
    });
    expect(
      (await api(c.app, "PUT", "/api/settings", { editMode: "sideways" }))
        .status,
    ).toBe(400);
  });

  it("can be set from the environment", () => {
    const t = tempDatabase();
    cleanups.push(t.cleanup);
    const view = readSettings(t.db, {
      HARNESS_EDIT_MODE: "in_place",
      HARNESS_ANSWER_AFTER_EDIT: "false",
    });
    expect(view.effective).toMatchObject({
      editMode: "in_place",
      answerAfterEdit: false,
    });
    expect(view.overriddenByEnv).toMatchObject({
      editMode: "HARNESS_EDIT_MODE",
      answerAfterEdit: "HARNESS_ANSWER_AFTER_EDIT",
    });
  });
});

describe("completePoints and regenerableTurn", () => {
  const stored = (
    id: string,
    message: Message,
    runId: string | null = null,
  ): StoredMessage => ({
    id,
    message,
    model: null,
    reasoningEffort: null,
    agent: null,
    usage: null,
    runId,
    parentCallId: null,
    parentId: null,
    branches: null,
  });
  const user = (id: string, runId: string | null = null) =>
    stored(id, { role: "user", content: id }, runId);
  const reply = (id: string) =>
    stored(
      id,
      { role: "assistant", content: [{ type: "text", text: id }] },
      "r",
    );
  const calls = (id: string, ...callIds: string[]) =>
    stored(
      id,
      {
        role: "assistant",
        content: callIds.map((callId) => ({
          type: "tool_call" as const,
          callId,
          name: "t",
          arguments: {},
        })),
      },
      "r",
    );
  const result = (id: string, callId: string) =>
    stored(
      id,
      { role: "tool", callId, name: "t", content: "x", isError: false },
      "r",
    );
  const edit = (id: string) =>
    stored(id, { role: "edit", content: "e", files: [] });

  it("allows user, edit and plain assistant messages, and the last result of a group", () => {
    const line = [
      user("u"),
      calls("a", "c1", "c2"),
      result("r1", "c1"),
      result("r2", "c2"),
      reply("done"),
      edit("e"),
    ];
    expect([...completePoints(line)]).toEqual(["u", "r2", "done", "e"]);
  });

  it("refuses a point while a call is still open", () => {
    expect([
      ...completePoints([user("u"), calls("a", "c1"), edit("e")]),
    ]).toEqual(["u"]);
    expect([...completePoints([user("u"), calls("a", "c1")])]).toEqual(["u"]);
  });

  it("starts a turn at the last user message no run wrote", () => {
    expect(
      regenerableTurn([user("u1"), reply("a1"), user("u2"), reply("a2")]),
    ).toBe("u2");
    // A message queued during a run (a run wrote it) does not start a turn.
    expect(
      regenerableTurn([user("u1"), reply("a1"), user("q", "r"), reply("a2")]),
    ).toBe("u1");
    expect(regenerableTurn([])).toBeNull();
    expect(regenerableTurn([user("u1")])).toBeNull();
    expect(regenerableTurn([user("u1"), reply("a1"), edit("e")])).toBeNull();
    expect(
      regenerableTurn([user("u1"), calls("a", "c1"), result("r", "c1")]),
    ).toBe("u1");
  });
});
