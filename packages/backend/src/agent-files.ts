import { parse, stringify } from "yaml";
import type { AgentContent } from "./agents-store.js";
import { AgentError } from "./agents-store.js";

/*
 * Agents as Markdown files with YAML front matter (agents design, decisions
 * 26 to 29 and 36), in Claude Code's shape:
 *
 *   ---
 *   name: Editor
 *   description: Tightens prose
 *   tools:            # allow list; `disallowedTools` for a deny list
 *     - web_search
 *   requireApproval:  # tools this agent asks about before each call
 *     - web_fetch
 *   skipApproval:     # tools it does not ask about
 *     - web_search
 *   ---
 *
 *   The system prompt.
 *
 * Without `tools` or `disallowedTools`, every tool is on (a deny list with
 * nothing in it), as in Claude Code. `requireApproval` and `skipApproval`
 * are written only when not empty (agent tool approval design, Q10).
 */

export function agentToMarkdown(agent: AgentContent): string {
  const approvals = Object.entries(agent.toolApproval);
  const asks = approvals.filter(([, ask]) => ask).map(([name]) => name);
  const skips = approvals.filter(([, ask]) => !ask).map(([name]) => name);
  const front: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    [agent.toolMode === "allow" ? "tools" : "disallowedTools"]: agent.tools,
    ...(asks.length > 0 ? { requireApproval: asks } : {}),
    ...(skips.length > 0 ? { skipApproval: skips } : {}),
  };
  return `---\n${stringify(front)}---\n\n${agent.prompt}\n`;
}

export interface ParsedAgentFile {
  content: AgentContent;
  /** Shown to the user, for example tools that were dropped. */
  warnings: string[];
}

/** A list of names, written as a YAML list or a comma-separated string. */
function names(value: unknown, field: string): string[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : null;
  if (raw === null || raw.some((v) => typeof v !== "string")) {
    throw new AgentError(
      `"${field}" must be a list of tool names or a comma-separated string.`,
      400,
    );
  }
  return (raw as string[]).map((t) => t.trim()).filter((t) => t !== "");
}

/**
 * Reads an agent file. Tools the harness does not have are dropped with a
 * warning (decision 29); the always-on tools are dropped silently, since
 * they cannot be selected (decision 8). In `requireApproval` and
 * `skipApproval`, tools the harness does not have, and tools that always
 * ask, are dropped with a warning; always-on tools are kept (agent tool
 * approval design, Q10). Other unknown fields are ignored.
 */
export function agentFromMarkdown(
  text: string,
  knownTools: readonly string[],
  alwaysOnTools: readonly string[],
  alwaysAskTools: readonly string[] = [],
): ParsedAgentFile {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  // The closing --- must be on a line of its own.
  const match = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) {
    throw new AgentError(
      "The file has no front matter (it must start with a line of ---).",
      400,
    );
  }
  let front: unknown;
  try {
    front = parse(match[1] ?? "");
  } catch (err) {
    throw new AgentError(
      `The front matter is not valid YAML: ${(err as Error).message}`,
      400,
    );
  }
  if (typeof front !== "object" || front === null || Array.isArray(front)) {
    throw new AgentError("The front matter must be a set of fields.", 400);
  }
  const f = front as Record<string, unknown>;
  if (typeof f.name !== "string" || f.name.trim() === "") {
    throw new AgentError('The front matter needs a "name".', 400);
  }
  if (f.description !== undefined && f.description !== null) {
    if (typeof f.description !== "string") {
      throw new AgentError('"description" must be text.', 400);
    }
  }
  const hasAllow = f.tools !== undefined && f.tools !== null;
  const hasDeny = f.disallowedTools !== undefined && f.disallowedTools !== null;
  if (hasAllow && hasDeny) {
    throw new AgentError(
      'The file has both "tools" and "disallowedTools"; an agent uses one or the other.',
      400,
    );
  }
  const listed = hasAllow
    ? names(f.tools, "tools")
    : hasDeny
      ? names(f.disallowedTools, "disallowedTools")
      : [];

  const known = new Set(knownTools);
  const alwaysOn = new Set(alwaysOnTools);
  const unknown = [...new Set(listed.filter((t) => !known.has(t)))];
  const tools = [
    ...new Set(listed.filter((t) => known.has(t) && !alwaysOn.has(t))),
  ];

  const asks = f.requireApproval
    ? names(f.requireApproval, "requireApproval")
    : [];
  const skips = f.skipApproval ? names(f.skipApproval, "skipApproval") : [];
  const both = asks.filter((t) => skips.includes(t));
  if (both.length > 0) {
    throw new AgentError(
      `"requireApproval" and "skipApproval" both name ${[...new Set(both)].join(", ")}; a tool is in one or the other.`,
      400,
    );
  }
  const fixed = new Set(alwaysAskTools);
  const unknownApproval = [
    ...new Set([...asks, ...skips].filter((t) => !known.has(t))),
  ];
  const fixedApproval = [
    ...new Set([...asks, ...skips].filter((t) => known.has(t) && fixed.has(t))),
  ];
  const usable = (t: string) => known.has(t) && !fixed.has(t);
  const toolApproval: Record<string, boolean> = {
    ...Object.fromEntries(asks.filter(usable).map((t) => [t, true])),
    ...Object.fromEntries(skips.filter(usable).map((t) => [t, false])),
  };

  // The blank line after the front matter and the final newline are the
  // file's, not the prompt's.
  const body = (match[2] ?? "").replace(/^\n/, "").replace(/\n$/, "");

  return {
    content: {
      name: f.name.trim(),
      description: typeof f.description === "string" ? f.description : "",
      prompt: body,
      toolMode: hasAllow ? "allow" : "deny",
      tools,
      toolApproval,
    },
    warnings: [
      ...(unknown.length > 0
        ? [
            `Dropped tool${unknown.length === 1 ? "" : "s"} this harness does not have: ${unknown.join(", ")}.`,
          ]
        : []),
      ...(unknownApproval.length > 0
        ? [
            `Dropped approval setting${unknownApproval.length === 1 ? "" : "s"} for tool${unknownApproval.length === 1 ? "" : "s"} this harness does not have: ${unknownApproval.join(", ")}.`,
          ]
        : []),
      ...(fixedApproval.length > 0
        ? [
            `Dropped approval setting${fixedApproval.length === 1 ? "" : "s"} for tool${fixedApproval.length === 1 ? "" : "s"} that always ask: ${fixedApproval.join(", ")}.`,
          ]
        : []),
    ],
  };
}
