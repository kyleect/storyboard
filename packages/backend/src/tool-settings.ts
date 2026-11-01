import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";
import type { Tool } from "@harness/core";

/*
 * Per-tool approval settings (tools design 6.5). Each tool has a default
 * (ask or not). Settings can switch it either way; "Always allow this tool"
 * switches asking off. Only differences from the default are stored, in the
 * settings table under one key.
 */

const KEY = "toolApproval";
const Stored = z.record(z.string(), z.object({ ask: z.boolean() }));

export interface ToolView {
  name: string;
  description: string;
  /** The tool's own default. */
  askByDefault: boolean;
  /** Whether it asks now: the setting, else the default. */
  ask: boolean;
}

function readStored(db: Database): z.infer<typeof Stored> {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY) as { value: string } | undefined;
  if (!row) return {};
  const parsed = Stored.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : {};
}

/** Whether the tool asks before running, by setting or by default. */
export function toolAsks(db: Database, tool: Tool): boolean {
  return readStored(db)[tool.name]?.ask ?? tool.approval === "ask";
}

export function listToolSettings(
  db: Database,
  tools: readonly Tool[],
): ToolView[] {
  const stored = readStored(db);
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    askByDefault: t.approval === "ask",
    ask: stored[t.name]?.ask ?? t.approval === "ask",
  }));
}

/** Sets whether the tool asks. A value equal to the default is not stored. */
export function setToolAsks(db: Database, tool: Tool, ask: boolean) {
  const stored = Object.fromEntries(
    Object.entries(readStored(db)).filter(([name]) => name !== tool.name),
  );
  if (ask !== (tool.approval === "ask")) stored[tool.name] = { ask };
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(KEY, JSON.stringify(stored));
}
