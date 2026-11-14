import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppEvents } from "./app-events.js";
import {
  ProfileError,
  setActiveProfile,
  type ProfileRow,
  type ProfileStore,
} from "./profiles.js";

/*
 * Routes for profiles (profiles design 4.3):
 *
 *   GET    /api/profiles              the profiles, the trashed ones, the active id
 *   POST   /api/profiles              create one (201)
 *   PUT    /api/profiles/:id          rename
 *   POST   /api/profiles/:id/trash    move to the trash (not the Default or
 *                                     the active profile)
 *   POST   /api/profiles/:id/restore  bring back from the trash
 *   POST   /api/profiles/:id/switch   make it the active profile
 *
 * A switch is refused (409) while any run is active, so a run never loses its
 * scope. Once it has happened every window is told by `profile.switched` and
 * starts again; the other changes are announced as `profiles.changed`.
 */

const IdParams = z.object({ id: z.string() });
const Body = z.object({ name: z.string() });

export interface ProfileRoutesDeps {
  store: ProfileStore;
  events: AppEvents;
  /** The sessions with a run in progress, with their titles. */
  activeSessions: () => { id: string; title: string }[];
  /**
   * Reloads what lives longer than a request (MCP connections, workspace
   * indexing) after the active profile changed. A failure is logged by the
   * caller; the switch has happened by then.
   */
  onSwitched?: (() => Promise<void>) | undefined;
  /** Where a failure of `onSwitched` goes. */
  onProblem?: ((message: string, err: unknown) => void) | undefined;
}

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: ProfileRoutesDeps,
) {
  const { store, events } = deps;

  const view = (): {
    active: string;
    profiles: ProfileRow[];
    trashed: ProfileRow[];
  } => ({
    active: store.current().id,
    profiles: store.list(),
    trashed: store.list(true),
  });

  const changed = (profileId: string) =>
    events.publish({ type: "profiles.changed", data: { profileId } });

  app.get("/api/profiles", async () => view());

  app.post("/api/profiles", async (req, reply) => {
    const profile = store.create(Body.parse(req.body).name);
    changed(profile.id);
    return reply.code(201).send(profile);
  });

  app.put("/api/profiles/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const profile = store.rename(id, Body.parse(req.body).name);
    changed(id);
    return profile;
  });

  app.post("/api/profiles/:id/trash", async (req) => {
    const { id } = IdParams.parse(req.params);
    const profile = store.trash(id);
    changed(id);
    return profile;
  });

  app.post("/api/profiles/:id/restore", async (req) => {
    const { id } = IdParams.parse(req.params);
    const profile = store.restore(id);
    changed(id);
    return profile;
  });

  app.post("/api/profiles/:id/switch", async (req) => {
    const { id } = IdParams.parse(req.params);
    const target = store.require(id);
    if (target.trashedAt !== null) {
      throw new ProfileError(
        "The profile is in the trash. Restore it first.",
        409,
      );
    }
    if (target.active) return view();

    const busy = deps.activeSessions();
    if (busy.length > 0) {
      const names = busy.map((s) => `"${s.title}"`).join(", ");
      throw new ProfileError(
        `A run is in progress in ${names}. Wait for it to end or cancel it before switching profiles.`,
        409,
      );
    }

    setActiveProfile(store.db, id);
    store.touch(id);
    try {
      await deps.onSwitched?.();
    } catch (err) {
      deps.onProblem?.("Reloading after a profile switch failed", err);
    }
    events.publish({ type: "profile.switched", data: { profileId: id } });
    return view();
  });
}
