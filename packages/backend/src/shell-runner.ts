import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import {
  ShellError,
  WorkspaceError,
  type ShellAccess,
  type ShellLocation,
  type ShellRequest,
  type ShellResult,
} from "@harness/core";
import { resolveIn } from "./workspace-fs.js";
import type { WorkspaceRow } from "./workspaces-store.js";

/*
 * Runs shell commands for the shell tool, behind core's `ShellAccess`. The
 * approval has already been given by the time `run` is called; this file
 * only keeps the command inside a workspace folder, ends it on time, and
 * turns its output into text a model can read.
 */

/** What the runner reads from Settings, each time a command runs. */
export interface ShellSettings {
  shellTimeoutSeconds: number;
  shellMaxTimeoutSeconds: number;
  shellOutputCap: number;
  shellProgram: string;
  shellArgs: string;
}

export interface ShellRunnerOptions {
  /** The workspaces the session can use now. */
  attached: () => WorkspaceRow[];
  settings: () => ShellSettings;
  /** The environment commands start from. Left out: this process's. */
  env?: NodeJS.ProcessEnv;
  /** Time between SIGTERM and SIGKILL. Left out: 5 seconds. */
  killGraceMs?: number;
  /** Time between live output messages. Left out: 500 ms. */
  liveIntervalMs?: number;
  /**
   * How long to wait for the output to end after the process has exited, for
   * a background process that keeps the pipe open. Left out: 500 ms.
   */
  drainMs?: number;
}

const DEFAULT_PROGRAM = "/bin/sh";
const DEFAULT_ARGS = ["-l", "-c"];
const ESC = "\u001b";
/* The escape character is the point of this pattern. */
/* eslint-disable no-control-regex */
/** An escape sequence that has started and not yet ended. */
const UNFINISHED =
  /^\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?|[ -/]*)?$/;
/* eslint-enable no-control-regex */

/** The environment for a command: everything but the harness's own settings. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("HARNESS_")) out[key] = value;
  }
  return out;
}

/** The program and arguments, before the command itself. */
export function shellCommandLine(
  settings: Pick<ShellSettings, "shellProgram" | "shellArgs">,
  env: NodeJS.ProcessEnv,
): { program: string; args: string[] } {
  const program =
    settings.shellProgram.trim() || env["SHELL"] || DEFAULT_PROGRAM;
  const given = settings.shellArgs.split(/\s+/).filter((a) => a !== "");
  return { program, args: given.length > 0 ? given : DEFAULT_ARGS };
}

/**
 * Keeps the start and the end of what it is given, up to a cap, and counts
 * what fell between. Under the cap the text is exact. Memory stays bounded
 * however much a command prints.
 */
export class OutputKeeper {
  private head = "";
  private tail = "";
  private cut = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(cap: number) {
    this.headCap = Math.ceil(cap / 2);
    this.tailCap = cap - this.headCap;
  }

  add(text: string): void {
    let rest = text;
    if (this.tail === "" && this.cut === 0 && this.head.length < this.headCap) {
      let room = this.headCap - this.head.length;
      // Do not split a character made of two code units.
      if (rest.length > room && isHigh(rest.charCodeAt(room - 1))) room -= 1;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest === "") return;
    this.tail += rest;
    if (this.tail.length > this.tailCap) {
      let drop = this.tail.length - this.tailCap;
      if (isLow(this.tail.charCodeAt(drop))) drop += 1;
      this.cut += drop;
      this.tail = this.tail.slice(drop);
    }
  }

  result(): { output: string; cutChars: number; cutAt: number } {
    return {
      output: this.head + this.tail,
      cutChars: this.cut,
      cutAt: this.cut > 0 ? this.head.length : 0,
    };
  }
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Removes terminal escape codes from text that arrives in pieces: a sequence
 * cut in two by a chunk boundary is held back until the rest comes.
 */
export class EscapeStripper {
  private held = "";

  push(chunk: string): string {
    const text = this.held + chunk;
    this.held = "";
    const at = text.lastIndexOf(ESC);
    if (at >= 0 && text.length - at < 64) {
      const tail = text.slice(at);
      if (UNFINISHED.test(tail)) {
        this.held = tail;
        return stripVTControlCharacters(text.slice(0, at));
      }
    }
    return stripVTControlCharacters(text);
  }

  /** What is left when the output has ended. */
  end(): string {
    const text = this.held;
    this.held = "";
    return stripVTControlCharacters(text);
  }
}

/** Sends text on every interval, and stops after `limit` characters. */
class LiveOutput {
  private pending = "";
  private sent = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly send: (text: string) => void,
    private readonly interval: number,
    private readonly limit: number,
  ) {}

  add(text: string): void {
    if (this.stopped || text === "") return;
    this.pending += text;
    this.timer ??= setTimeout(() => this.flush(), this.interval);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.stopped || this.pending === "") return;
    const room = this.limit - this.sent;
    let text = this.pending;
    this.pending = "";
    if (text.length >= room) {
      text = text.slice(0, Math.max(room, 0));
      this.stopped = true;
      this.send(text + "\n[The rest of the output is not shown live.]\n");
      return;
    }
    this.sent += text.length;
    this.send(text);
  }

  /** Sends what is waiting and ends the timer. */
  end(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.stopped = true;
  }
}

export function createShellAccess(options: ShellRunnerOptions): ShellAccess {
  const baseEnv = options.env ?? process.env;
  const killGraceMs = options.killGraceMs ?? 5000;
  const liveIntervalMs = options.liveIntervalMs ?? 500;
  const drainMs = options.drainMs ?? 500;

  /** The folder a request names, checked as the workspace tools check theirs. */
  const folderOf = (request: ShellRequest): string => {
    const w = options.attached().find((x) => x.id === request.workspaceId);
    if (!w) {
      throw new WorkspaceError(
        "not_found",
        `No workspace with the id ${request.workspaceId} is attached to this session. Call workspaces_list.`,
      );
    }
    if (!existsSync(w.path)) {
      throw new WorkspaceError(
        "unavailable",
        `The folder of the workspace "${w.name}" is not there any more (${w.path}).`,
      );
    }
    if (!w.writable) {
      throw new WorkspaceError(
        "read_only",
        `The workspace "${w.name}" is read-only here.`,
      );
    }
    const abs = resolveIn(w.path, request.path);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new WorkspaceError(
        "not_found",
        `There is no folder "${request.path}" in the workspace "${w.name}".`,
      );
    }
    return abs;
  };

  /** The attached workspace that holds a full path, the innermost first. */
  const locate = (text: string): ShellLocation | { error: string } => {
    const asked = text.trim();
    const listed = options
      .attached()
      .map((w) => `${w.name}: ${w.path}`)
      .join("; ");
    const hint = listed
      ? `The folders of the workspaces are: ${listed}.`
      : "This session has no workspaces.";
    if (asked === "" || !isAbsolute(asked)) {
      return {
        error: `cwd must be the full path of a folder, such as a workspace's path from workspaces_list. ${hint}`,
      };
    }
    const cwd = resolve(asked);
    let best: { w: WorkspaceRow; rel: string } | undefined;
    for (const w of options.attached()) {
      const rel = relative(resolve(w.path), cwd);
      const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      if (inside && (!best || w.path.length > best.w.path.length)) {
        best = { w, rel };
      }
    }
    if (!best) {
      return {
        error: `${cwd} is not inside a workspace. ${hint}`,
      };
    }
    return {
      workspace: {
        id: best.w.id,
        name: best.w.name,
        path: best.w.path,
        writable: best.w.writable,
      },
      path: best.rel.split(sep).join("/"),
      cwd,
    };
  };

  return {
    locate,
    get defaultTimeoutSeconds() {
      const s = options.settings();
      return Math.min(s.shellTimeoutSeconds, s.shellMaxTimeoutSeconds);
    },
    get maxTimeoutSeconds() {
      return options.settings().shellMaxTimeoutSeconds;
    },
    async run(request, io): Promise<ShellResult> {
      const cwd = folderOf(request);
      const settings = options.settings();
      const { program, args } = shellCommandLine(settings, baseEnv);
      const started = Date.now();

      const child = spawn(program, [...args, request.command], {
        cwd,
        env: commandEnv(baseEnv),
        // A new process group, so the whole tree can be ended together.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const keeper = new OutputKeeper(settings.shellOutputCap);
      const stripper = new EscapeStripper();
      const live = new LiveOutput(
        io.onOutput,
        liveIntervalMs,
        settings.shellOutputCap,
      );
      const take = (text: string) => {
        if (text === "") return;
        keeper.add(text);
        live.add(text);
      };
      // One decoder for each stream: a character split across two chunks of
      // one stream is joined; invalid bytes become U+FFFD.
      const decoders: StringDecoder[] = [];
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        decoders.push(decoder);
        stream?.on("data", (data: Buffer) => {
          take(stripper.push(decoder.write(data)));
        });
      }

      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          // The group is already gone.
        }
      };
      const end = () => {
        if (killTimer) return;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
      };
      const limit = setTimeout(() => {
        timedOut = true;
        end();
      }, request.timeoutSeconds * 1000);
      const onAbort = () => end();
      if (io.signal.aborted) onAbort();
      else io.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const exit = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((done, fail) => {
          child.once("error", (err: NodeJS.ErrnoException) =>
            fail(
              new ShellError(
                `Could not start the shell "${program}": ${err.message}`,
              ),
            ),
          );
          child.once("exit", (code, signal) => done({ code, signal }));
        });
        // The output usually ends with the process; a background process
        // that kept the pipe open must not hold the call, so wait briefly.
        await new Promise<void>((done) => {
          const wait = setTimeout(done, drainMs);
          let open = 0;
          for (const stream of [child.stdout, child.stderr]) {
            if (!stream || stream.destroyed || stream.readableEnded) continue;
            open += 1;
            stream.once("close", () => {
              open -= 1;
              if (open === 0) {
                clearTimeout(wait);
                done();
              }
            });
          }
          if (open === 0) {
            clearTimeout(wait);
            done();
          }
        });
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const d of decoders) take(stripper.push(d.end()));
        take(stripper.end());
        live.end();
        const kept = keeper.result();
        return {
          exitCode: exit.code,
          signal: exit.signal,
          timedOut,
          durationMs: Date.now() - started,
          ...kept,
        };
      } finally {
        clearTimeout(limit);
        if (killTimer) clearTimeout(killTimer);
        io.signal.removeEventListener("abort", onAbort);
        live.end();
      }
    },
  };
}
