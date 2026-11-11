/*
 * App-wide events, sent to every window on GET /api/events (agents plan,
 * P7). Unlike session events they are not stored and not replayed: a
 * window refetches what it shows when its stream opens or reopens.
 */

export type AppEvent =
  | {
      type: "agents.changed";
      data: {
        /** The agent created, saved, deleted, restored or imported. */
        agentId: string;
        /** Null: a global agent. */
        projectId: string | null;
        /** Sessions whose pick was cleared (a delete; decision 23). */
        clearedSessions: string[];
      };
    }
  | {
      /** A skill was created, saved, deleted or restored (skills design). */
      type: "skills.changed";
      data: {
        skillId: string;
        /** Set for a project's skill. */
        projectId: string | null;
        /** Set for an agent's skill. */
        agentId: string | null;
      };
    }
  | {
      /**
       * Global, project or agent data changed: in the app, or by a tool in a
       * run (schemas and data design). Windows refetch what they show.
       */
      type: "data.changed";
      data: Record<string, never>;
    }
  | {
      /**
       * A project was created by a tool (agent tools design, Q17), so every
       * window can refresh its project list.
       */
      type: "projects.changed";
      data: { projectId: string };
    }
  | {
      /**
       * An MCP server was created, saved, deleted or reconnected, or its
       * connection changed (MCP design): windows refetch the servers and
       * their tools.
       */
      type: "mcp.changed";
      data: { serverId: string };
    }
  | {
      /**
       * A workspace, an attachment or a "Always allow" grant for one changed
       * (files unification design): windows refetch them.
       */
      type: "workspaces.changed";
      data: Record<string, never>;
    }
  | {
      /**
       * An error was recorded, or errors were cleared (error reporting
       * plan, P6).
       */
      type: "errors.changed";
      data: {
        /** The session whose errors changed; null: a global Clear. */
        sessionId: string | null;
      };
    }
  | {
      /**
       * A run started or ended, or began or stopped waiting for an approval
       * or a form. Windows refetch the active runs (GET /api/runs/active)
       * for the activity indicators.
       */
      type: "runs.changed";
      data: { sessionId: string; runId: string };
    };

type Listener = (event: AppEvent) => void;

export class AppEvents {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: AppEvent) {
    for (const l of this.listeners) l(event);
  }
}
