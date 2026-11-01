import type {
  ApprovalChoice,
  ApprovalRequest,
  ContentBlock,
  ControlResult,
  Message,
  Usage,
} from "@harness/core";

/*
 * Talks to the backend. The token arrives once in the URL fragment
 * (#token=...), is kept in sessionStorage for reloads, and is removed from
 * the address bar.
 */

const TOKEN_KEY = "harness.token";

function readToken(): string | null {
  const match = /(?:^|[#&])token=([0-9a-f]+)/.exec(window.location.hash);
  if (match?.[1]) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // storage unavailable; the token still works for this page load
    }
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export const token = readToken();

// Opening a new #token= link in a tab that is already open only changes the
// hash, which does not reload the page; reload so the new token is used.
window.addEventListener("hashchange", () => {
  if (/(?:^|[#&])token=[0-9a-f]+/.test(window.location.hash)) {
    window.location.reload();
  }
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    throw new ApiError(
      "The backend rejected the token. Open the link the backend printed when it started.",
      401,
    );
  }
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  /** The session's chosen model; null means the default setting. */
  model: string | null;
  /** The session's chosen reasoning effort; null means the default. */
  reasoning_effort: string | null;
  /** When it was moved to the trash; null when it is not in the trash. */
  trashed_at: string | null;
  /** The project it belongs to; null for a standalone session. */
  project_id: string | null;
  /** 1 when it went to the trash because its project did. */
  trashed_with_project: number;
}

/** A session in a list, with how full its context is. */
export interface SessionListItem extends Session {
  /** The usage of its latest model call that reported one; null: none. */
  usage: Usage | null;
}

export interface Project {
  id: string;
  name: string;
  /** Empty when there is none. */
  description: string;
  created_at: string;
  last_used_at: string;
  /** When it was moved to the trash; null when it is not in the trash. */
  trashed_at: string | null;
}

/** Everything in the trash. */
export interface Trash {
  /** Each with the sessions trashed together with it. */
  projects: (Project & { sessions: Session[] })[];
  /** Sessions trashed on their own. */
  sessions: Session[];
}

export interface StoredMessage {
  id: string;
  message: Message;
  /** For assistant messages: the model of the run that last wrote it. */
  model: string | null;
  /** For assistant messages: the effort of the run that last wrote it. */
  reasoningEffort: string | null;
  /**
   * For assistant messages: the usage of the model call that last wrote it.
   * Null when none was reported, and for other messages.
   */
  usage: Usage | null;
}

export interface SessionDetail {
  session: Session;
  /** The session's project; null for a standalone session. */
  project: Project | null;
  messages: StoredMessage[];
  lastEventId: number;
  activeRun: {
    runId: string;
    model: string | null;
    reasoningEffort: string | null;
    /** The message being written now; null while a tool runs. */
    message: {
      messageId: string;
      continuing: boolean;
      content: ContentBlock[];
    } | null;
    /** Approval requests waiting for an answer. */
    approvals: ApprovalRequest[];
  } | null;
}

/** A tool and whether it asks before running. */
export interface ToolView {
  name: string;
  description: string;
  askByDefault: boolean;
  ask: boolean;
}

export interface Settings {
  llamaServerUrl: string;
  model: string;
  reasoningEffort: string;
  port: number;
  /** The most model calls one run makes. */
  loopLimit: number;
  /** Days in the trash before deletion at startup; 0: never. */
  trashRetentionDays: number;
}

export interface SettingsView {
  effective: Settings;
  stored: Partial<Settings>;
  overriddenByEnv: Partial<Record<keyof Settings, string>>;
}

export interface ModelInfo {
  id: string;
  /** Router mode only, for example "loaded", "loading" or "unloaded". */
  status?: string;
  /** Router mode only: the last load attempt failed. */
  failed?: boolean;
}

/** Sent with a message or continue; they become the session's choices. */
export interface Choices {
  model?: string;
  reasoningEffort?: string;
}

export const api = {
  listModels: () => request<ModelInfo[]>("GET", "/api/models"),
  /** Starts loading a model on the router; GET /api/models shows progress. */
  loadModel: (model: string) =>
    request<
      { ok: true; alreadyRunning: boolean } | { ok: false; message: string }
    >("POST", "/api/models/load", { model }),
  /** A field left out is unchanged; null returns it to the default. */
  setSessionChoices: (
    id: string,
    choices: { model?: string | null; reasoningEffort?: string | null },
  ) => request<Session>("PATCH", `/api/sessions/${id}`, choices),
  reasoningLevels: (model: string | undefined) =>
    request<{ levels: string[] } | { unavailable: string }>(
      "GET",
      `/api/models/reasoning-levels${
        model ? `?model=${encodeURIComponent(model)}` : ""
      }`,
    ),
  /** One slot's context size in tokens, read without loading the model. */
  contextSize: (model: string | undefined) =>
    request<{ contextSize: number } | { unavailable: string }>(
      "GET",
      `/api/models/context-size${
        model ? `?model=${encodeURIComponent(model)}` : ""
      }`,
    ),
  endReasoning: (runId: string) =>
    request<ControlResult>("POST", `/api/runs/${runId}/end-reasoning`),
  /** A project's sessions, or the standalone ones when null. */
  listSessions: (projectId: string | null) =>
    request<SessionListItem[]>(
      "GET",
      `/api/sessions${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      }`,
    ),
  /** Creates a session, in a project when one is given. */
  createSession: (projectId: string | null) =>
    request<Session>("POST", "/api/sessions", projectId ? { projectId } : {}),
  getSession: (id: string) =>
    request<SessionDetail>("GET", `/api/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    request<Session>("PATCH", `/api/sessions/${id}`, { title }),
  trashSession: (id: string) =>
    request<Session>("POST", `/api/sessions/${id}/trash`),
  /**
   * When the session's project is in the trash, `project` says whether the
   * project comes back with all the sessions trashed with it, or only this
   * one.
   */
  restoreSession: (id: string, project?: "all" | "only") =>
    request<Session>(
      "POST",
      `/api/sessions/${id}/restore`,
      project ? { project } : {},
    ),
  /** Permanently deletes a session in the trash. */
  deleteSession: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/sessions/${id}`),
  getTrash: () => request<Trash>("GET", "/api/trash"),
  emptyTrash: () =>
    request<{ purged: { projects: number; sessions: number } }>(
      "DELETE",
      "/api/trash",
    ),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  getProject: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  createProject: (p: { name: string; description: string }) =>
    request<Project>("POST", "/api/projects", p),
  /** A field left out is unchanged. */
  updateProject: (
    id: string,
    fields: { name?: string; description?: string },
  ) => request<Project>("PATCH", `/api/projects/${id}`, fields),
  trashProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/trash`),
  restoreProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/restore`),
  /** Permanently deletes a project in the trash, with its sessions. */
  deleteProject: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/projects/${id}`),
  sendMessage: (id: string, content: string, choices: Choices) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/messages`, {
      content,
      ...choices,
    }),
  continueLast: (id: string, choices: Choices) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/continue`, choices),
  cancelRun: (runId: string) =>
    request<{ cancelled: boolean }>("POST", `/api/runs/${runId}/cancel`),
  answerApproval: (runId: string, requestId: string, choice: ApprovalChoice) =>
    request<{ ok: true }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}`,
      { choice },
    ),
  listTools: () => request<ToolView[]>("GET", "/api/tools"),
  setToolAsks: (name: string, ask: boolean) =>
    request<ToolView>(
      "PUT",
      `/api/tools/${encodeURIComponent(name)}/approval`,
      { ask },
    ),
  getSettings: () => request<SettingsView>("GET", "/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<SettingsView>("PUT", "/api/settings", patch),
};

export function eventsUrl(sessionId: string, lastEventId: number): string {
  const q = new URLSearchParams({
    token: token ?? "",
    lastEventId: String(lastEventId),
  });
  return `/api/sessions/${sessionId}/events?${q.toString()}`;
}
