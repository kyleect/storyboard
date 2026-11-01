/*
 * App-wide events, sent to every window on GET /api/events (agents plan,
 * P7). Unlike session events they are not stored and not replayed: a
 * window refetches what it shows when its stream opens or reopens.
 */

export type AppEvent = {
  type: "agents.changed";
  data: {
    /** The agent created, saved, deleted, restored or imported. */
    agentId: string;
    /** Null: a global agent. */
    projectId: string | null;
    /** Sessions whose pick was cleared (a delete; decision 23). */
    clearedSessions: string[];
  };
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
