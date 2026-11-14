import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";
import type { Tool, ToolGroup } from "@harness/core";
import { getStoredSetting, putStoredSetting } from "./settings.js";

/*
 * Per-tool approval settings (tools design 6.5). Each tool has a default
 * (ask or not). Settings can switch it either way; "Always allow this tool"
 * switches asking off. Only differences from the default are stored, in the
 * settings table under one key.
 */

const KEY = "toolApproval";
const Stored = z.record(z.string(), z.object({ ask: z.boolean() }));

/*
 * Which tools are always on, and which are off for the whole harness (tool
 * management design, decision 12). Like the approval setting, only
 * differences from the tool's own default are stored: `alwaysOn` holds a
 * tool's value when it differs from `tool.alwaysOn`, and `off` is a list.
 */
const ALWAYS_ON_KEY = "toolAlwaysOn";
const OFF_KEY = "toolsOff";
const StoredAlwaysOn = z.record(z.string(), z.boolean());
const StoredOff = z.array(z.string());

export interface ToolView {
  name: string;
  description: string;
  group: ToolGroup;
  /** Whether it is offered to every agent now: the setting, else the default. */
  alwaysOn: boolean;
  /** The tool's own default for always on. */
  alwaysOnByDefault: boolean;
  /** Switched off for the whole harness. */
  off: boolean;
  /** Destructive or prompt-changing: a group grant does not cover it. */
  needsReview: boolean;
  /** The tool's own default. */
  askByDefault: boolean;
  /** Whether it asks now: the setting, else the default. */
  ask: boolean;
  /** True for a tool that always asks: the setting cannot change it. */
  fixed: boolean;
}

/** Whether the tool asks every time, whatever the settings say. */
export const alwaysAsks = (tool: Tool): boolean => tool.approval === "always";

/** Thrown when a setting is changed for a tool that always asks. */
export class FixedApprovalError extends Error {
  override name = "FixedApprovalError";
}

function readStored(db: Database): z.infer<typeof Stored> {
  const value = getStoredSetting(db, KEY);
  if (value === undefined) return {};
  const parsed = Stored.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : {};
}

/**
 * Whether a call asks, and whether the agent's own setting decides it (agent
 * tool approval design, section 3): a tool that always asks, else the
 * agent's setting for the tool, else the tool's setting, else its default.
 */
export function toolApproval(
  db: Database,
  tool: Tool,
  agent: { toolApproval: Readonly<Record<string, boolean>> } | null | undefined,
): { ask: boolean; byAgent: boolean } {
  if (alwaysAsks(tool)) return { ask: true, byAgent: false };
  const own = agent?.toolApproval[tool.name];
  if (own !== undefined) return { ask: own, byAgent: true };
  return { ask: toolAsks(db, tool), byAgent: false };
}

/** Whether the tool asks before running, by setting or by default. */
export function toolAsks(db: Database, tool: Tool): boolean {
  if (alwaysAsks(tool)) return true;
  return readStored(db)[tool.name]?.ask ?? tool.approval === "ask";
}

function readJson<T>(
  db: Database,
  key: string,
  schema: z.ZodType<T>,
  empty: T,
): T {
  const value = getStoredSetting(db, key);
  if (value === undefined) return empty;
  const parsed = schema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : empty;
}

function writeJson(db: Database, key: string, value: unknown) {
  putStoredSetting(db, key, JSON.stringify(value));
}

/** The names of the tools that are always on now. */
export function alwaysOnNames(
  db: Database,
  tools: readonly Tool[],
): Set<string> {
  const stored = readJson(db, ALWAYS_ON_KEY, StoredAlwaysOn, {});
  return new Set(
    tools.filter((t) => stored[t.name] ?? t.alwaysOn).map((t) => t.name),
  );
}

/** The names of the tools that are off for the whole harness. */
export function offNames(db: Database): Set<string> {
  return new Set(readJson(db, OFF_KEY, StoredOff, []));
}

/** Sets whether the tool is always on. A value equal to the default is not stored. */
export function setToolAlwaysOn(db: Database, tool: Tool, value: boolean) {
  const stored = Object.fromEntries(
    Object.entries(readJson(db, ALWAYS_ON_KEY, StoredAlwaysOn, {})).filter(
      ([name]) => name !== tool.name,
    ),
  );
  if (value !== tool.alwaysOn) stored[tool.name] = value;
  writeJson(db, ALWAYS_ON_KEY, stored);
}

/** Switches a tool off for the whole harness, or back on. */
export function setToolOff(db: Database, tool: Tool, off: boolean) {
  const names = [...offNames(db)].filter((n) => n !== tool.name);
  if (off) names.push(tool.name);
  writeJson(db, OFF_KEY, names);
}

export function listToolSettings(
  db: Database,
  tools: readonly Tool[],
): ToolView[] {
  const stored = readStored(db);
  const alwaysOn = alwaysOnNames(db, tools);
  const off = offNames(db);
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    group: t.group,
    alwaysOn: alwaysOn.has(t.name),
    alwaysOnByDefault: t.alwaysOn,
    off: off.has(t.name),
    needsReview: t.needsReview,
    askByDefault: t.approval !== "never",
    ask: alwaysAsks(t) || (stored[t.name]?.ask ?? t.approval === "ask"),
    fixed: alwaysAsks(t),
  }));
}

/** Sets whether the tool asks. A value equal to the default is not stored. */
export function setToolAsks(db: Database, tool: Tool, ask: boolean) {
  if (alwaysAsks(tool)) {
    throw new FixedApprovalError(
      `${tool.name} always asks for approval; this cannot be changed.`,
    );
  }
  const stored = Object.fromEntries(
    Object.entries(readStored(db)).filter(([name]) => name !== tool.name),
  );
  if (ask !== (tool.approval === "ask")) stored[tool.name] = { ask };
  putStoredSetting(db, KEY, JSON.stringify(stored));
}
