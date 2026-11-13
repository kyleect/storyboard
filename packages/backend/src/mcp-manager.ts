import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  FileError,
  ToolError,
  truncate,
  type MediaRef,
  type Tool,
  type ToolContext,
} from "@harness/core";
import { detectMedia, MAX_UPLOAD_BYTES } from "./media-detect.js";
import type { AppEvents } from "./app-events.js";
import type { McpServer, McpServerStore } from "./mcp-store.js";

/*
 * The backend as an MCP client (MCP design). For each enabled server the
 * manager connects, lists the server's tools and turns each into a harness
 * `Tool` in the "mcp" group. Those tools go through the same grants,
 * approvals and settings as the built-in ones (`RunManager.tools` includes
 * them), so nothing else needs to know a tool comes from MCP.
 *
 * Only tools are used. Connecting happens in the background: the backend
 * does not wait for a slow server to start, and a server that fails to
 * connect only has its own tools missing. A tool whose server is not
 * connected is not offered to new runs; a call to one that was offered
 * earlier tries to reconnect once.
 */

export type McpState = "disabled" | "connecting" | "connected" | "failed";

/** A tool as the settings page lists it. */
export interface McpToolInfo {
  /** The name agents and settings use. */
  name: string;
  /** The server's own name for it. */
  serverName: string;
  description: string;
}

export interface McpStatus {
  state: McpState;
  /** Why it failed; null unless `state` is "failed". */
  error: string | null;
  tools: McpToolInfo[];
}

export interface McpManagerOptions {
  store: McpServerStore;
  events?: AppEvents | undefined;
  /** Makes the transport for a server. Default: stdio or Streamable HTTP. */
  createTransport?: ((server: McpServer) => Transport) | undefined;
  /** How long a connection may take, in ms. Default 15 s. */
  connectTimeoutMs?: number | undefined;
  /** How long a tool call may take, in ms. Default 60 s. */
  callTimeoutMs?: number | undefined;
  /** The longest result text given to the model. Default 60 000. */
  maxResultChars?: number | undefined;
  /** Called with problems worth logging. */
  onProblem?: ((message: string, err: unknown) => void) | undefined;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 60_000;
/** The most of a stdio server's stderr kept for an error message. */
const STDERR_KEEP = 2_000;
/** The most tools read from one server (a guard against a runaway cursor). */
const MAX_TOOL_PAGES = 20;
const MAX_TOOL_NAME = 64;

interface Live {
  client: Client;
  transport: Transport;
  tools: Tool[];
  info: McpToolInfo[];
}

interface Entry {
  server: McpServer;
  state: McpState;
  error: string | null;
  live: Live | null;
  /** The connection in progress, so a second request waits for it. */
  connecting: Promise<void> | null;
  /** Bumps on every connect and disconnect; stale callbacks check it. */
  generation: number;
  /** The tail of a stdio server's stderr. */
  stderr: string;
}

export class McpManager {
  private readonly entries = new Map<string, Entry>();
  private cache: readonly Tool[] | null = null;
  private stopped = false;

  constructor(private readonly options: McpManagerOptions) {
    for (const server of options.store.list()) this.track(server);
  }

  /** Starts connecting every enabled server; does not wait for them. */
  start() {
    for (const entry of this.entries.values()) {
      if (entry.server.enabled) void this.connect(entry.server.id);
    }
  }

  /** The tools of every connected server, in server then tool order. */
  get tools(): readonly Tool[] {
    this.cache ??= [...this.entries.values()]
      .filter((e) => e.state === "connected" && e.live)
      .sort((a, b) => a.server.name.localeCompare(b.server.name))
      .flatMap((e) => e.live?.tools ?? []);
    return this.cache;
  }

  /** What the settings page shows for a server. */
  status(id: string): McpStatus {
    const entry = this.entries.get(id);
    if (!entry) return { state: "disabled", error: null, tools: [] };
    return {
      state: entry.state,
      error: entry.state === "failed" ? entry.error : null,
      tools: entry.state === "connected" ? (entry.live?.info ?? []) : [],
    };
  }

  /** A server was created: starts it when it is enabled. */
  add(server: McpServer) {
    this.track(server);
    if (server.enabled) void this.connect(server.id);
  }

  /** A server's settings were saved: reconnects with them. */
  async replace(server: McpServer): Promise<void> {
    await this.disconnect(server.id);
    this.entries.delete(server.id);
    this.track(server);
    if (server.enabled) await this.connect(server.id);
    else this.changed(server.id);
  }

  /** A server was deleted. */
  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.entries.delete(id);
    this.invalidate();
    this.options.events?.publish({
      type: "mcp.changed",
      data: { serverId: id },
    });
  }

  /**
   * Connects the server, ending any connection it has. Resolves when the
   * attempt is over; a failure is the server's status, not a rejection.
   */
  connect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.stopped) return Promise.resolve();
    if (entry.connecting) return entry.connecting;
    const attempt = this.open(entry).finally(() => {
      if (entry.connecting === attempt) entry.connecting = null;
    });
    entry.connecting = attempt;
    return attempt;
  }

  /** Closes the server's connection. */
  async disconnect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.generation++;
    const live = entry.live;
    entry.live = null;
    entry.state = entry.server.enabled ? "failed" : "disabled";
    entry.error = entry.server.enabled ? "Disconnected." : null;
    this.invalidate();
    await close(live);
  }

  /** Closes every connection; the manager does not connect again. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.entries.keys()].map((id) => this.disconnect(id)),
    );
  }

  private track(server: McpServer) {
    this.entries.set(server.id, {
      server,
      state: server.enabled ? "failed" : "disabled",
      error: server.enabled ? "Not connected yet." : null,
      live: null,
      connecting: null,
      generation: 0,
      stderr: "",
    });
  }

  private invalidate() {
    this.cache = null;
  }

  private changed(id: string) {
    this.invalidate();
    this.options.events?.publish({
      type: "mcp.changed",
      data: { serverId: id },
    });
  }

  private transportFor(entry: Entry): Transport {
    if (this.options.createTransport) {
      return this.options.createTransport(entry.server);
    }
    const config = entry.server.config;
    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        stderr: "pipe",
        ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      });
      // Read stderr so the child never blocks on it, and keep the tail for
      // the error message when the server fails to start.
      transport.stderr?.on("data", (chunk: Buffer) => {
        entry.stderr = (entry.stderr + chunk.toString()).slice(-STDERR_KEEP);
      });
      return transport;
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }

  private async open(entry: Entry): Promise<void> {
    const { server } = entry;
    if (!server.enabled) return;
    await close(entry.live);
    entry.live = null;
    const generation = ++entry.generation;
    entry.state = "connecting";
    entry.error = null;
    entry.stderr = "";
    this.changed(server.id);
    const current = () => entry.generation === generation && !this.stopped;

    const client = new Client(
      { name: "storyboard-harness", version: "0.0.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!current() || error || !tools || !entry.live) return;
              this.setTools(entry, entry.live, tools);
            },
          },
        },
      },
    );
    const transport = this.transportFor(entry);
    client.onclose = () => {
      if (!current()) return;
      entry.live = null;
      entry.state = "failed";
      entry.error = "The connection closed.";
      this.changed(server.id);
    };
    client.onerror = (err) =>
      this.options.onProblem?.(`MCP server "${server.name}" reported`, err);

    try {
      const timeout = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      await client.connect(transport, { timeout });
      const listed = await listAllTools(client, timeout);
      if (!current()) {
        await close({ client, transport });
        return;
      }
      const live: Live = { client, transport, tools: [], info: [] };
      entry.live = live;
      this.setTools(entry, live, listed);
      entry.state = "connected";
      entry.error = null;
    } catch (err) {
      await close({ client, transport });
      if (!current()) return;
      entry.live = null;
      entry.state = "failed";
      entry.error = describeFailure(err, entry.stderr);
      this.options.onProblem?.(
        `MCP server "${server.name}" failed to connect`,
        err,
      );
    }
    this.changed(server.id);
  }

  /** Replaces a connection's tools with these. */
  private setTools(entry: Entry, live: Live, listed: McpTool[]) {
    const taken = new Set<string>();
    live.tools = [];
    live.info = [];
    for (const mcp of listed) {
      const name = toolName(entry.server.name, mcp.name, taken);
      const tool = this.makeTool(entry, name, mcp);
      live.tools.push(tool);
      live.info.push({
        name,
        serverName: mcp.name,
        description: tool.description,
      });
    }
    this.changed(entry.server.id);
  }

  private makeTool(entry: Entry, name: string, mcp: McpTool): Tool {
    const { server } = entry;
    // The declared dialect is dropped, as `defineTool` does for its own.
    const inputSchema = { ...(mcp.inputSchema as Record<string, unknown>) };
    delete inputSchema.$schema;
    // The server's hints are not trusted (a server can say anything), so
    // they never lower the approval: every MCP tool asks by default. They
    // only decide whether a group grant covers the tool: a tool that is not
    // marked read-only has to be granted on its own.
    const readOnly = mcp.annotations?.readOnlyHint === true;
    return {
      name,
      description:
        mcp.description ?? mcp.annotations?.title ?? mcp.title ?? mcp.name,
      approval: "ask",
      group: "mcp",
      alwaysOn: false,
      needsReview: !readOnly,
      inputSchema: { ...inputSchema, type: "object" },
      parse: (args) =>
        args !== null && typeof args === "object" && !Array.isArray(args)
          ? { ok: true, input: args }
          : { ok: false, error: "The arguments must be a JSON object." },
      execute: async (input, ctx) => {
        const live = await this.liveFor(entry);
        let result: CallToolResult;
        try {
          result = (await live.client.callTool(
            { name: mcp.name, arguments: input as Record<string, unknown> },
            undefined,
            {
              signal: ctx.signal,
              timeout: this.options.callTimeoutMs ?? CALL_TIMEOUT_MS,
            },
          )) as CallToolResult;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          throw new ToolError(
            `The MCP server "${server.name}" failed the call: ${errorMessage(err)}`,
            {
              cause: err,
              details: { server: server.name, tool: mcp.name },
            },
          );
        }
        // Images and audio are saved as session files, so the model can be
        // shown them (files unification design, D57).
        const media: MediaRef[] = [];
        const text = truncate(
          resultText(result, (mimeType, data) => {
            const ref = saveMedia(ctx, name, mimeType, data);
            if (ref) media.push({ ref });
            return ref;
          }),
          this.options.maxResultChars ?? MAX_RESULT_CHARS,
        );
        return result.isError === true
          ? {
              data: text === "" ? "The tool reported an error." : text,
              isError: true,
              details: { server: server.name, tool: mcp.name },
            }
          : { data: text, ...(media.length > 0 ? { media } : {}) };
      },
    };
  }

  /** The server's live connection; tries to reconnect once when it is gone. */
  private async liveFor(entry: Entry): Promise<Live> {
    if (!entry.live && entry.server.enabled)
      await this.connect(entry.server.id);
    if (!entry.live) {
      throw new ToolError(
        `The MCP server "${entry.server.name}" is not connected` +
          (entry.error ? `: ${entry.error}` : "."),
        { details: { server: entry.server.name, state: entry.state } },
      );
    }
    return entry.live;
  }
}

async function close(live: Pick<Live, "client" | "transport"> | null) {
  if (!live) return;
  live.client.onclose = () => {};
  try {
    await live.client.close();
  } catch {
    // Already closed or the process is gone.
  }
}

/** Every tool the server lists, following its paging. */
async function listAllTools(
  client: Client,
  timeout: number,
): Promise<McpTool[]> {
  const all: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await client.listTools(
      cursor !== undefined ? { cursor } : {},
      { timeout },
    );
    all.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return all;
}

/**
 * The name the harness gives an MCP tool: `mcp_<server>_<tool>`, with
 * characters a tool name cannot have turned into "_", cut to 64 characters,
 * and made unique among `taken` (added to).
 */
export function toolName(
  server: string,
  mcpName: string,
  taken: Set<string>,
): string {
  const base = `mcp_${server}_${
    mcpName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool"
  }`;
  let name = base.slice(0, MAX_TOOL_NAME);
  for (let n = 2; taken.has(name); n++) {
    const suffix = `_${n}`;
    name = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

/**
 * Saves an image or audio result as a session file and returns its
 * reference, or undefined when it cannot be (no blob store, not a format the
 * model server reads, too large, or the bytes do not match the type).
 */
export function saveMedia(
  ctx: ToolContext,
  toolName: string,
  mimeType: string,
  base64: string,
): string | undefined {
  if (!ctx.blobs) return undefined;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_UPLOAD_BYTES) return undefined;
  const found = detectMedia(mimeType, bytes);
  if (!found) return undefined;
  const blob = ctx.blobs.put(found.mediaType, bytes);
  for (let n = 1; n <= 100; n++) {
    const key = `${toolName}-${n}.${found.extension}`;
    // Writing over a live file would replace it, so skip a name in use.
    if (ctx.files.readFile("session", key)) continue;
    try {
      ctx.files.putBlob("session", key, found.mediaType, blob);
      return `session://${key}`;
    } catch (err) {
      if (!(err instanceof FileError)) throw err;
    }
  }
  return undefined;
}

/**
 * A tool result as text for the model. Text is kept. An image or audio
 * block is passed to `save`; when that returns a reference the text names
 * it, otherwise (and for other binary content) the block is named and left
 * out. A result with no content but structured content is that, as JSON.
 */
export function resultText(
  result: CallToolResult,
  save?: (mimeType: string, base64: string) => string | undefined,
): string {
  const parts = (result.content ?? []).map((block): string => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
      case "audio": {
        const ref = save?.(block.mimeType, block.data);
        return ref
          ? `[${block.type} saved as <${ref}>]`
          : `[${block.type} omitted: ${block.mimeType}, about ${Math.round((block.data.length * 3) / 4)} bytes]`;
      }
      case "resource": {
        if ("text" in block.resource) return block.resource.text;
        const ref =
          block.resource.mimeType && "blob" in block.resource
            ? save?.(block.resource.mimeType, block.resource.blob)
            : undefined;
        return ref
          ? `[resource ${block.resource.uri} saved as <${ref}>]`
          : `[binary resource omitted: ${block.resource.uri}]`;
      }
      case "resource_link":
        return `[resource link: ${block.uri}]`;
      default:
        return "";
    }
  });
  const text = parts.filter((p) => p !== "").join("\n");
  if (text === "" && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a connection failed, with a stdio server's last stderr when it has any. */
function describeFailure(err: unknown, stderr: string): string {
  const tail = stderr.trim();
  const message = errorMessage(err);
  return tail === "" ? message : `${message}\n${tail}`;
}
