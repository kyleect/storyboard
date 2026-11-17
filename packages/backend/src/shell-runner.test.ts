import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScriptedModel,
  ShellError,
  WorkspaceError,
  type ChatRequest,
  type ScriptStep,
} from "@harness/core";
import { allTools } from "@harness/tools";
import { AgentStore } from "./agents-store.js";
import { FileStore } from "./files-store.js";
import { RunManager } from "./runs.js";
import {
  commandEnv,
  createShellAccess,
  EscapeStripper,
  OutputKeeper,
  shellCommandLine,
  type ShellSettings,
} from "./shell-runner.js";
import { buildServer } from "./server.js";
import { readSettings, writeSettings } from "./settings.js";
import { Store } from "./store.js";
import { clearBuiltinAgents, grant, tempDatabase } from "./test-helpers.js";
import { WorkspaceStore, type WorkspaceRow } from "./workspaces-store.js";

/*
 * The shell runner with real processes, and the shell tool in real runs with
 * a scripted model. The runner tests need a POSIX shell, so they are skipped
 * on Windows, where the tool is not offered either.
 */

const posix = process.platform === "win32" ? describe.skip : describe;
const TOKEN = "t".repeat(64);

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function folder() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "harness-shell-")));
  const dir = join(base, "book");
  mkdirSync(dir);
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return dir;
}

const SETTINGS: ShellSettings = {
  shellTimeoutSeconds: 30,
  shellMaxTimeoutSeconds: 60,
  shellOutputCap: 10_000,
  shellProgram: "/bin/sh",
  shellArgs: "-c",
};

const row = (dir: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow =>
  ({
    id: "w1",
    name: "Book",
    path: dir,
    writable: true,
    ...over,
  }) as WorkspaceRow;

function runner(
  dir: string,
  over: {
    settings?: Partial<ShellSettings>;
    env?: NodeJS.ProcessEnv;
    row?: Partial<WorkspaceRow>;
    killGraceMs?: number;
    liveIntervalMs?: number;
    drainMs?: number;
  } = {},
) {
  return createShellAccess({
    attached: () => [row(dir, over.row)],
    settings: () => ({ ...SETTINGS, ...over.settings }),
    env: over.env ?? { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    ...(over.killGraceMs !== undefined
      ? { killGraceMs: over.killGraceMs }
      : {}),
    ...(over.liveIntervalMs !== undefined
      ? { liveIntervalMs: over.liveIntervalMs }
      : {}),
    ...(over.drainMs !== undefined ? { drainMs: over.drainMs } : {}),
  });
}

function exec(
  access: ReturnType<typeof runner>,
  command: string,
  over: { path?: string; timeoutSeconds?: number; signal?: AbortSignal } = {},
) {
  const live: string[] = [];
  const result = access.run(
    {
      workspaceId: "w1",
      path: over.path ?? "",
      command,
      timeoutSeconds: over.timeoutSeconds ?? 10,
    },
    {
      signal: over.signal ?? new AbortController().signal,
      onOutput: (t) => live.push(t),
    },
  );
  return { result, live };
}

describe("OutputKeeper", () => {
  it("keeps all the text under the cap", () => {
    const k = new OutputKeeper(100);
    k.add("hello ");
    k.add("world");
    expect(k.result()).toEqual({
      output: "hello world",
      cutChars: 0,
      cutAt: 0,
    });
  });

  it("keeps the start and the end over the cap, and counts the middle", () => {
    const k = new OutputKeeper(10);
    k.add("0123456789");
    k.add("abcdefghij");
    k.add("KLMNO");
    const r = k.result();
    expect(r.output).toBe("01234" + "jKLMNO".slice(1));
    expect(r.cutAt).toBe(5);
    expect(r.cutChars + r.output.length).toBe(25);
  });

  it("does not split a character made of two code units", () => {
    const k = new OutputKeeper(4);
    k.add("ab😀cd😀ef");
    const { output, cutChars, cutAt } = k.result();
    expect(output).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(output).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(cutChars + output.length).toBe("ab😀cd😀ef".length);
    expect(cutAt).toBeGreaterThan(0);
  });
});

describe("EscapeStripper", () => {
  it("removes color codes", () => {
    expect(new EscapeStripper().push("\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("removes a sequence split across chunks", () => {
    const s = new EscapeStripper();
    const out = s.push("a\u001b[3") + s.push("1mb") + s.end();
    expect(out).toBe("ab");
  });

  it("passes text with no escape through", () => {
    expect(new EscapeStripper().push("plain\n")).toBe("plain\n");
  });
});

describe("commandEnv and shellCommandLine", () => {
  it("drops HARNESS_ variables and keeps the rest", () => {
    expect(
      commandEnv({
        PATH: "/bin",
        HARNESS_TOKEN: "x",
        HOME: "/h",
        HARNESS: "y",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h", HARNESS: "y" });
  });

  it("uses the override, then $SHELL, then /bin/sh", () => {
    const none = { shellProgram: "", shellArgs: "" };
    expect(shellCommandLine({ ...none, shellProgram: "/x/fish" }, {})).toEqual({
      program: "/x/fish",
      args: ["-l", "-c"],
    });
    expect(shellCommandLine(none, { SHELL: "/bin/zsh" }).program).toBe(
      "/bin/zsh",
    );
    expect(shellCommandLine(none, {}).program).toBe("/bin/sh");
  });

  it("splits the arguments on spaces", () => {
    expect(
      shellCommandLine({ shellProgram: "", shellArgs: " -i   -c " }, {}).args,
    ).toEqual(["-i", "-c"]);
  });
});

posix("createShellAccess", () => {
  it("runs a command in the folder and returns its output and exit code", async () => {
    const dir = folder();
    const r = await exec(runner(dir), "pwd; echo done").result;
    expect(r).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      output: `${dir}\ndone\n`,
      cutChars: 0,
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs in a folder inside the workspace", async () => {
    const dir = folder();
    mkdirSync(join(dir, "src"));
    const r = await exec(runner(dir), "pwd", { path: "src" }).result;
    expect(r.output).toBe(`${join(dir, "src")}\n`);
  });

  it("returns a failing command as a result", async () => {
    const r = await exec(runner(folder()), "echo no >&2; exit 3").result;
    expect(r).toMatchObject({ exitCode: 3, output: "no\n", timedOut: false });
  });

  it("reads standard output and standard error as one text, in order", async () => {
    const r = await exec(
      runner(folder()),
      "echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three",
    ).result;
    expect(r.output).toBe("one\ntwo\nthree\n");
  });

  it("closes standard input, so a program that reads it returns at once", async () => {
    const r = await exec(runner(folder()), "cat; echo after").result;
    expect(r).toMatchObject({ exitCode: 0, output: "after\n" });
  });

  it("removes terminal escape codes and replaces invalid UTF-8", async () => {
    const r = await exec(
      runner(folder()),
      "printf '\\033[31mred\\033[0m \\377x\\n'",
    ).result;
    expect(r.output).toBe("red �x\n");
  });

  it("joins a character split across two writes", async () => {
    const r = await exec(
      runner(folder()),
      "printf '\\342\\202'; sleep 0.1; printf '\\254\\n'",
    ).result;
    expect(r.output).toBe("€\n");
  });

  it("cuts the middle of long output and says where", async () => {
    const r = await exec(
      runner(folder(), { settings: { shellOutputCap: 100 } }),
      "seq 1 1000",
    ).result;
    expect(r.cutChars).toBeGreaterThan(0);
    expect(r.output.length).toBe(100);
    expect(r.cutAt).toBe(50);
    expect(r.output.startsWith("1\n2\n3\n")).toBe(true);
    expect(r.output.endsWith("999\n1000\n")).toBe(true);
    const all = Array.from({ length: 1000 }, (_, i) => `${i + 1}\n`).join("");
    expect(r.cutChars + r.output.length).toBe(all.length);
  });

  it("does not pass HARNESS_ variables to the command", async () => {
    const r = await exec(
      runner(folder(), {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HARNESS_TOKEN: "secret",
          KEPT: "yes",
        },
      }),
      'echo "[${HARNESS_TOKEN}] [${KEPT}]"',
    ).result;
    expect(r.output).toBe("[] [yes]\n");
  });

  it("ends a command at the time limit", async () => {
    const t = Date.now();
    const r = await exec(runner(folder()), "echo start; sleep 30", {
      timeoutSeconds: 1,
    }).result;
    expect(r.timedOut).toBe(true);
    expect(r.output).toBe("start\n");
    expect(r.exitCode === null || r.exitCode > 0).toBe(true);
    expect(Date.now() - t).toBeLessThan(10_000);
  });

  it("ends the whole process group, not only the shell", async () => {
    const dir = folder();
    const r = await exec(runner(dir), "sleep 30 & echo $! > pid.txt; wait", {
      timeoutSeconds: 1,
    }).result;
    expect(r.timedOut).toBe(true);
    const pid = readFileSync(join(dir, "pid.txt"), "utf8").trim();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // An ended process may stay as a zombie until its parent reaps it.
    const state = (() => {
      try {
        return execFileSync("ps", ["-o", "stat=", "-p", pid], {
          encoding: "utf8",
        }).trim();
      } catch {
        return "";
      }
    })();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("sends SIGKILL to a command that ignores SIGTERM", async () => {
    const r = await exec(
      runner(folder(), { killGraceMs: 200 }),
      "trap '' TERM; while true; do sleep 0.1; done",
      { timeoutSeconds: 1 },
    ).result;
    expect(r.timedOut).toBe(true);
    expect(r.signal ?? r.exitCode).not.toBe(0);
  });

  it("ends the command when the signal fires", async () => {
    const abort = new AbortController();
    const { result } = exec(runner(folder()), "sleep 30", {
      signal: abort.signal,
      timeoutSeconds: 30,
    });
    setTimeout(() => abort.abort(), 100);
    const r = await result;
    expect(r.timedOut).toBe(false);
    expect(r.signal).toBe("SIGTERM");
  });

  it("does not wait for a background process that keeps the output open", async () => {
    const t = Date.now();
    const r = await exec(
      runner(folder(), { drainMs: 200 }),
      "(sleep 5; echo late) & echo now",
    ).result;
    expect(r.output).toBe("now\n");
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it("sends output as it arrives, and stops live output at the cap", async () => {
    const { result, live } = exec(
      runner(folder(), {
        liveIntervalMs: 20,
        settings: { shellOutputCap: 100 },
      }),
      "echo first; sleep 0.2; seq 1 1000",
    );
    await result;
    expect(live[0]).toBe("first\n");
    expect(live.join("")).toContain(
      "[The rest of the output is not shown live.]",
    );
    expect(live.filter((x) => x.includes("not shown live"))).toHaveLength(1);
    expect(live.join("").length).toBeLessThan(300);
  });

  it("uses the shell and arguments from Settings", async () => {
    const r = await exec(
      runner(folder(), {
        settings: { shellProgram: "/bin/sh", shellArgs: "-c" },
      }),
      "echo $0",
    ).result;
    expect(r.output.trim()).toBe("/bin/sh");
  });

  it("throws a ShellError when the shell cannot be started", async () => {
    const run = exec(
      runner(folder(), { settings: { shellProgram: "/no/such/shell" } }),
      "echo hi",
    ).result;
    await expect(run).rejects.toBeInstanceOf(ShellError);
    await expect(run).rejects.toThrow(/\/no\/such\/shell/);
  });

  it("refuses a folder that leaves the workspace", async () => {
    const dir = folder();
    await expect(
      exec(runner(dir), "pwd", { path: ".." }).result,
    ).rejects.toMatchObject({ code: "outside" });
    const outside = folder();
    symlinkSync(outside, join(dir, "link"));
    await expect(
      exec(runner(dir), "pwd", { path: "link" }).result,
    ).rejects.toMatchObject({ code: "outside" });
  });

  it("refuses a read-only workspace, an unknown one and a missing folder", async () => {
    const dir = folder();
    await expect(
      exec(runner(dir, { row: { writable: false } }), "pwd").result,
    ).rejects.toMatchObject({ code: "read_only" });
    const access = runner(dir);
    await expect(
      access.run(
        { workspaceId: "nope", path: "", command: "pwd", timeoutSeconds: 5 },
        { signal: new AbortController().signal, onOutput: () => {} },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      exec(access, "pwd", { path: "missing" }).result,
    ).rejects.toBeInstanceOf(WorkspaceError);
    writeFileSync(join(dir, "file.txt"), "x");
    await expect(
      exec(access, "pwd", { path: "file.txt" }).result,
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("finds the workspace that holds a full path", () => {
    const dir = folder();
    const access = runner(dir);
    expect(access.locate(`${dir}/src/../lib`)).toEqual({
      workspace: { id: "w1", name: "Book", path: dir, writable: true },
      path: "lib",
      cwd: `${dir}/lib`,
    });
    expect(access.locate(dir)).toMatchObject({ path: "", cwd: dir });
  });

  it("picks the innermost of nested workspaces", () => {
    const dir = folder();
    const inner = { id: "w2", name: "Inner", path: join(dir, "inner") };
    const access = createShellAccess({
      attached: () => [row(dir), row(inner.path, inner)],
      settings: () => SETTINGS,
    });
    expect(access.locate(join(dir, "inner", "x"))).toMatchObject({
      workspace: { id: "w2" },
      path: "x",
    });
    expect(access.locate(join(dir, "other"))).toMatchObject({
      workspace: { id: "w1" },
      path: "other",
    });
  });

  it("does not take a sibling folder with the same start for the workspace", () => {
    const dir = folder();
    const access = runner(dir);
    expect(access.locate(`${dir}-copy/x`)).toHaveProperty("error");
  });

  it("refuses a path outside every workspace, a relative one and an empty one", () => {
    const dir = folder();
    const access = runner(dir);
    for (const bad of ["/etc", `${dir}/..`, "src", "workspace://w1/", ""]) {
      const found = access.locate(bad);
      expect(found).toHaveProperty("error");
      // The error tells the model where the workspaces are.
      expect((found as { error: string }).error).toContain(dir);
    }
  });

  it("reads the time limits from Settings each time", () => {
    let s = { ...SETTINGS };
    const access = createShellAccess({
      attached: () => [],
      settings: () => s,
    });
    expect(access.defaultTimeoutSeconds).toBe(30);
    expect(access.maxTimeoutSeconds).toBe(60);
    s = { ...s, shellTimeoutSeconds: 500, shellMaxTimeoutSeconds: 100 };
    expect(access.maxTimeoutSeconds).toBe(100);
    // A default above the maximum is lowered to it.
    expect(access.defaultTimeoutSeconds).toBe(100);
  });
});

/* The tool in real runs. */

const call = (callId: string, name: string, args: object = {}): ScriptStep => ({
  type: "tool_call",
  callId,
  name,
  arguments: JSON.stringify(args),
});
const done: ScriptStep[] = [{ type: "text", text: "done" }];
const toolNames = (r: ChatRequest) => (r.tools ?? []).map((t) => t.name);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function setupRun(scripts: ScriptStep[][], settings = {}) {
  const t = tempDatabase();
  clearBuiltinAgents(t.db);
  writeSettings(t.db, { systemPrompt: "", ...settings });
  const store = new Store(t.db);
  const files = new FileStore(t.db);
  const agents = new AgentStore(t.db);
  const workspaces = new WorkspaceStore(t.db);
  const model = new ScriptedModel(scripts);
  const runs = new RunManager({
    store,
    settings: () => ({
      ...readSettings(t.db, {}).effective,
      autoRename: false,
    }),
    model: () => model,
    tools: allTools,
    agents,
    files,
    workspaces,
  });
  const app = buildServer({
    store,
    runs,
    files,
    agents,
    workspaces,
    token: TOKEN,
    env: {},
  });
  await app.ready();
  cleanups.push(t.cleanup, () => app.close());
  return { t, store, runs, app, model, workspaces, agents, scripts };
}

async function newSession(c: Awaited<ReturnType<typeof setupRun>>) {
  const res = await c.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { title: "T" },
  });
  return res.json().id as string;
}

async function go(
  c: Awaited<ReturnType<typeof setupRun>>,
  sessionId: string,
  decisions: ("once" | "session" | "always" | "deny")[] = [],
) {
  const res = await c.app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { content: "Go" },
  });
  const runId = res.json().runId as string;
  const asked: {
    name: string;
    subject?: { label: string };
    alwaysAsks?: boolean;
    args: unknown;
  }[] = [];
  const deadline = Date.now() + 15_000;
  while (c.runs.isActive(runId)) {
    if (Date.now() > deadline) throw new Error("The run did not end in time.");
    const run = c.runs.snapshot(sessionId).activeRun;
    const approval = run?.approvals[0];
    if (run && approval) {
      asked.push(approval as never);
      c.runs.answerApproval(run.runId, approval.requestId, {
        choice: decisions.shift() ?? "once",
      });
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  return asked;
}

function results(c: Awaited<ReturnType<typeof setupRun>>, sessionId: string) {
  return c.store.listMessages(sessionId, "top").flatMap((m) =>
    m.message.role === "tool"
      ? [
          {
            name: m.message.name,
            isError: m.message.isError,
            data: m.message.data as Json,
          },
        ]
      : [],
  );
}

posix("shell_run in a run", () => {
  let n = 0;
  const attach = (c: Awaited<ReturnType<typeof setupRun>>, writable = true) =>
    c.workspaces.create(
      { scope: "global" },
      { name: n++ === 0 ? "Book" : `Book ${n}`, path: folder(), writable },
    );

  it("is offered only to a session with a writable workspace", async () => {
    const c = await setupRun([done, done, done]);
    const id = await newSession(c);
    await go(c, id);
    expect(toolNames(c.model.requests[0] as ChatRequest)).not.toContain(
      "shell_run",
    );
    attach(c, false);
    await go(c, id);
    expect(toolNames(c.model.requests[1] as ChatRequest)).not.toContain(
      "shell_run",
    );
    attach(c, true);
    await go(c, id);
    expect(toolNames(c.model.requests[2] as ChatRequest)).toContain(
      "shell_run",
    );
  });

  it("asks every call, names the workspace, and runs the command once allowed", async () => {
    const c = await setupRun([]);
    const w = attach(c);
    c.scripts.push(
      [
        call("a", "shell_run", {
          cwd: w.path,
          command: "echo hello > out.txt && cat out.txt",
        }),
        call("b", "shell_run", { cwd: w.path, command: "echo again" }),
      ],
      done,
    );
    const id = await newSession(c);
    // "Allow once" for the first; a second call asks again.
    const asked = await go(c, id, ["once", "once"]);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      name: "shell_run",
      alwaysAsks: true,
      subject: { label: w.name },
    });
    const [first, second] = results(c, id);
    expect(first?.isError).toBe(false);
    expect(first?.data).toMatchObject({
      exitCode: 0,
      timedOut: false,
      output: "hello\n",
      workspace: w.name,
    });
    expect(second?.data.output).toBe("again\n");
  });

  it("does not run a denied command, and the run goes on", async () => {
    const c = await setupRun([]);
    const w = attach(c);
    c.scripts.push(
      [call("a", "shell_run", { cwd: w.path, command: "touch denied.txt" })],
      done,
    );
    const id = await newSession(c);
    const asked = await go(c, id, ["deny"]);
    expect(asked).toHaveLength(1);
    const [r] = results(c, id);
    expect(r?.isError).toBe(true);
    expect(existsSync(join(w.path, "denied.txt"))).toBe(false);
  });

  it("gives the model the real folder, and refuses a folder outside the workspaces", async () => {
    const c = await setupRun([]);
    const w = attach(c);
    c.scripts.push(
      [
        call("a", "workspaces_list"),
        call("b", "shell_run", { cwd: "/", command: "touch outside.txt" }),
        call("c", "shell_run", { cwd: w.path, command: "pwd" }),
      ],
      done,
    );
    const id = await newSession(c);
    const asked = await go(c, id);
    // The call outside every workspace names no workspace in its approval.
    expect(asked[0]?.subject).toBeUndefined();
    const [list, outside, inside] = results(c, id);
    expect(list?.data.workspaces[0]).toMatchObject({
      name: w.name,
      path: w.path,
    });
    expect(outside?.isError).toBe(true);
    expect(outside?.data.error).toContain(w.path);
    expect(existsSync("/outside.txt")).toBe(false);
    expect(inside?.data).toMatchObject({
      output: `${w.path}\n`,
      folder: w.path,
    });
  });

  it("does not pass the backend's HARNESS_ variables to a command", async () => {
    process.env["HARNESS_SHELL_TEST_SECRET"] = "leak";
    cleanups.push(() => {
      delete process.env["HARNESS_SHELL_TEST_SECRET"];
    });
    const c = await setupRun([]);
    const w = attach(c);
    c.scripts.push(
      [
        call("a", "shell_run", {
          cwd: w.path,
          command: 'echo "[$HARNESS_SHELL_TEST_SECRET]"',
        }),
      ],
      done,
    );
    const id = await newSession(c);
    await go(c, id);
    expect(results(c, id)[0]?.data.output).toBe("[]\n");
  });

  it("uses the time limits from Settings", async () => {
    const c = await setupRun([], {
      shellTimeoutSeconds: 5,
      shellMaxTimeoutSeconds: 7,
    });
    const w = attach(c);
    c.scripts.push(
      [
        call("a", "shell_run", { cwd: w.path, command: "echo a" }),
        call("b", "shell_run", {
          cwd: w.path,
          command: "echo b",
          timeout_seconds: 3600,
        }),
      ],
      done,
    );
    const id = await newSession(c);
    await go(c, id);
    const [a, b] = results(c, id);
    expect(a?.data.timeoutSeconds).toBe(5);
    expect(b?.data.timeoutSeconds).toBe(7);
    expect(b?.data.notice).toContain("7");
  });

  it("is not given to an agent in deny mode until it is listed", async () => {
    const c = await setupRun([done, done]);
    attach(c);
    const agent = c.agents.create(null, {
      name: "Plain",
      description: "",
      prompt: "x",
      toolGrant: grant("deny", ["workspace_read"]),
      toolApproval: {},
    });
    const id = await newSession(c);
    c.store.setSessionChoices(id, { agentId: agent.id });
    await go(c, id);
    expect(toolNames(c.model.requests[0] as ChatRequest)).not.toContain(
      "shell_run",
    );
    const given = c.agents.create(null, {
      name: "Given",
      description: "",
      prompt: "x",
      toolGrant: {
        ...grant("deny", ["workspace_read"]),
        except: ["shell_run"],
      },
      toolApproval: {},
    });
    const second = await newSession(c);
    c.store.setSessionChoices(second, { agentId: given.id });
    await go(c, second);
    expect(toolNames(c.model.requests[1] as ChatRequest)).toContain(
      "shell_run",
    );
  });
});
