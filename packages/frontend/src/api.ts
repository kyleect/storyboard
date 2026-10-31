import type { ContentBlock, Message } from "@harness/core";

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
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status);
  return data as T;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  /** The session's chosen model; null means the default setting. */
  model: string | null;
}

export interface StoredMessage {
  id: string;
  message: Message;
  /** For assistant messages: the model of the run that last wrote it. */
  model: string | null;
}

export interface SessionDetail {
  session: Session;
  messages: StoredMessage[];
  lastEventId: number;
  activeRun: {
    runId: string;
    messageId: string;
    model: string | null;
    continuing: boolean;
    content: ContentBlock[];
  } | null;
}

export interface Settings {
  llamaServerUrl: string;
  model: string;
  port: number;
}

export interface SettingsView {
  effective: Settings;
  stored: Partial<Settings>;
  overriddenByEnv: Partial<Record<keyof Settings, string>>;
}

export interface ModelInfo {
  id: string;
  /** Router mode only, for example "loaded" or "unloaded". */
  status?: string;
}

export const api = {
  listModels: () => request<ModelInfo[]>("GET", "/api/models"),
  setSessionModel: (id: string, model: string | null) =>
    request<Session>("PATCH", `/api/sessions/${id}`, { model }),
  listSessions: () => request<Session[]>("GET", "/api/sessions"),
  createSession: (title?: string) =>
    request<Session>("POST", "/api/sessions", title ? { title } : {}),
  getSession: (id: string) =>
    request<SessionDetail>("GET", `/api/sessions/${id}`),
  sendMessage: (id: string, content: string, model?: string) =>
    request<{ runId: string }>(
      "POST",
      `/api/sessions/${id}/messages`,
      model ? { content, model } : { content },
    ),
  continueLast: (id: string, model?: string) =>
    request<{ runId: string }>(
      "POST",
      `/api/sessions/${id}/continue`,
      model ? { model } : {},
    ),
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
