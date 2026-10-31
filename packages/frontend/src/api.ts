import type { ContentBlock, ControlResult, Message } from "@harness/core";

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
}

export interface StoredMessage {
  id: string;
  message: Message;
  /** For assistant messages: the model of the run that last wrote it. */
  model: string | null;
  /** For assistant messages: the effort of the run that last wrote it. */
  reasoningEffort: string | null;
}

export interface SessionDetail {
  session: Session;
  messages: StoredMessage[];
  lastEventId: number;
  activeRun: {
    runId: string;
    messageId: string;
    model: string | null;
    reasoningEffort: string | null;
    continuing: boolean;
    content: ContentBlock[];
  } | null;
}

export interface Settings {
  llamaServerUrl: string;
  model: string;
  reasoningEffort: string;
  port: number;
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
  endReasoning: (runId: string) =>
    request<ControlResult>("POST", `/api/runs/${runId}/end-reasoning`),
  listSessions: () => request<Session[]>("GET", "/api/sessions"),
  createSession: (title?: string) =>
    request<Session>("POST", "/api/sessions", title ? { title } : {}),
  getSession: (id: string) =>
    request<SessionDetail>("GET", `/api/sessions/${id}`),
  sendMessage: (id: string, content: string, choices: Choices) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/messages`, {
      content,
      ...choices,
    }),
  continueLast: (id: string, choices: Choices) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/continue`, choices),
  cancelRun: (runId: string) =>
    request<{ cancelled: boolean }>("POST", `/api/runs/${runId}/cancel`),
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
