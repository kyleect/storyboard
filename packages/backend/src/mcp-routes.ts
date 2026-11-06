import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppEvents } from "./app-events.js";
import type { McpManager, McpStatus } from "./mcp-manager.js";
import {
  McpServerError,
  ServerInput,
  type McpServer,
  type McpServerStore,
} from "./mcp-store.js";

/*
 * Routes for MCP servers (MCP design):
 *
 *   GET    /api/mcp/servers                 every server, with its status
 *   POST   /api/mcp/servers                 create; it connects at once
 *   GET    /api/mcp/servers/:id
 *   PUT    /api/mcp/servers/:id             replace its settings; reconnects
 *   DELETE /api/mcp/servers/:id
 *   POST   /api/mcp/servers/:id/reconnect   connect again; answers when done
 *
 * A save, delete or reconnect is announced on the app-wide stream as
 * `mcp.changed`; the manager also announces every change of a connection.
 * Creating and saving answer before the server has connected (except
 * reconnect, which waits): the status says where it is.
 */

const IdParams = z.object({ id: z.string() });

export function registerMcpRoutes(
  app: FastifyInstance,
  deps: { store: McpServerStore; manager: McpManager; events: AppEvents },
) {
  const { store, manager, events } = deps;

  const serverOf = (req: FastifyRequest): McpServer => {
    const { id } = IdParams.parse(req.params);
    const server = store.get(id);
    if (!server) throw new McpServerError("MCP server not found.", 404);
    return server;
  };

  const view = (server: McpServer): McpServer & { status: McpStatus } => ({
    ...server,
    status: manager.status(server.id),
  });

  app.get("/api/mcp/servers", async () => store.list().map(view));

  app.post("/api/mcp/servers", async (req, reply) => {
    const server = store.create(ServerInput.parse(req.body));
    manager.add(server);
    events.publish({ type: "mcp.changed", data: { serverId: server.id } });
    return reply.code(201).send(view(server));
  });

  app.get("/api/mcp/servers/:id", async (req) => view(serverOf(req)));

  app.put("/api/mcp/servers/:id", async (req) => {
    const current = serverOf(req);
    const server = store.update(current.id, ServerInput.parse(req.body));
    // Reconnects in the background; the answer does not wait for it.
    void manager.replace(server);
    events.publish({ type: "mcp.changed", data: { serverId: server.id } });
    return view(server);
  });

  app.delete("/api/mcp/servers/:id", async (req, reply) => {
    const server = serverOf(req);
    store.delete(server.id);
    await manager.remove(server.id);
    return reply.code(204).send();
  });

  app.post("/api/mcp/servers/:id/reconnect", async (req) => {
    const server = serverOf(req);
    if (!server.enabled) {
      throw new McpServerError("The server is turned off.", 409);
    }
    await manager.disconnect(server.id);
    await manager.connect(server.id);
    return view(server);
  });
}
