import type { Database } from "better-sqlite3-multiple-ciphers";
import { z } from "zod";
import { activeProfile } from "./profiles.js";

/*
 * The MCP servers the backend connects to as a client (MCP design). A
 * server is either started by the backend (`stdio`) or reached over the
 * network (`http`, MCP's Streamable HTTP). The row holds the settings; what
 * a connection looks like now (connecting, connected, failed) is the
 * manager's to know, not stored.
 */

/**
 * The longest server name. A tool is named `mcp_<server>_<tool>` and a tool
 * name is at most 64 characters, so a short server name leaves room for the
 * tool's own.
 */
export const MAX_SERVER_NAME = 24;

/** Lowercase letters, digits and "-"; starts with a letter or digit. */
const SERVER_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class McpServerError extends Error {
  override name = "McpServerError";
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
  }
}

const Strings = z.record(z.string().min(1), z.string());

export const StdioConfig = z.object({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  /** Added to the safe subset of this process's environment. */
  env: Strings.default({}),
  /** Left out: the backend's working directory. */
  cwd: z.string().min(1).optional(),
});

export const HttpConfig = z.object({
  transport: z.literal("http"),
  url: z.url().refine((u) => /^https?:$/.test(new URL(u).protocol), {
    message: "The URL must start with http:// or https://.",
  }),
  /** Sent with every request, e.g. `Authorization`. */
  headers: Strings.default({}),
});

export const ServerConfig = z.discriminatedUnion("transport", [
  StdioConfig,
  HttpConfig,
]);
export type ServerConfig = z.infer<typeof ServerConfig>;

/** What the user enters. */
export const ServerInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SERVER_NAME)
    .regex(
      SERVER_NAME,
      "Use lowercase letters, digits and '-', starting with a letter or digit.",
    ),
  enabled: z.boolean().default(true),
  config: ServerConfig,
});
export type ServerInput = z.input<typeof ServerInput>;

export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  config: ServerConfig;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  transport: "stdio" | "http";
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): McpServer {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    config: ServerConfig.parse({
      ...(JSON.parse(row.config) as object),
      transport: row.transport,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The transport is its own column; the rest of the config is the JSON. */
function split(config: ServerConfig): { transport: string; json: string } {
  const { transport, ...rest } = config;
  return { transport, json: JSON.stringify(rest) };
}

export class McpServerStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  list(): McpServer[] {
    return (
      this.db
        .prepare("SELECT * FROM mcp_servers WHERE profile_id = ? ORDER BY name")
        .all(activeProfile(this.db)) as Row[]
    ).map(fromRow);
  }

  get(id: string): McpServer | undefined {
    const row = this.db
      .prepare("SELECT * FROM mcp_servers WHERE profile_id = ? AND id = ?")
      .get(activeProfile(this.db), id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  create(input: ServerInput): McpServer {
    const parsed = ServerInput.parse(input);
    this.requireFreeName(parsed.name);
    const id = this.newId();
    const at = this.now();
    const { transport, json } = split(parsed.config);
    this.db
      .prepare(
        `INSERT INTO mcp_servers
           (id, profile_id, name, transport, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        activeProfile(this.db),
        parsed.name,
        transport,
        json,
        parsed.enabled ? 1 : 0,
        at,
        at,
      );
    return this.require(id);
  }

  /** Replaces the server's settings; its id stays. */
  update(id: string, input: ServerInput): McpServer {
    this.require(id);
    const parsed = ServerInput.parse(input);
    this.requireFreeName(parsed.name, id);
    const { transport, json } = split(parsed.config);
    this.db
      .prepare(
        `UPDATE mcp_servers
            SET name = ?, transport = ?, config = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        parsed.name,
        transport,
        json,
        parsed.enabled ? 1 : 0,
        this.now(),
        id,
      );
    return this.require(id);
  }

  delete(id: string): McpServer {
    const server = this.require(id);
    this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return server;
  }

  private require(id: string): McpServer {
    const server = this.get(id);
    if (!server) throw new McpServerError("MCP server not found.", 404);
    return server;
  }

  private requireFreeName(name: string, exceptId?: string) {
    const row = this.db
      .prepare("SELECT id FROM mcp_servers WHERE profile_id = ? AND name = ?")
      .get(activeProfile(this.db), name) as { id: string } | undefined;
    if (row && row.id !== exceptId) {
      throw new McpServerError(
        `There is already an MCP server named "${name}".`,
        409,
      );
    }
  }
}
