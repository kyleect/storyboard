import type {
  ApprovalAnswer,
  ApprovalRequest,
  ContentBlock,
  ControlResult,
  EntryKind,
  FileType,
  InputAnswer,
  InputRequest,
  Message,
  RunAgent,
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
    /** The response body, for errors that carry details. */
    readonly body: unknown = undefined,
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
  if (!res.ok)
    throw new ApiError(data.error ?? res.statusText, res.status, data);
  return data as T;
}

/** A GET that returns text (an agent export). */
async function requestText(path: string): Promise<string> {
  const res = await fetch(path, {
    headers: { authorization: `Bearer ${token ?? ""}` },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? res.statusText, res.status, data);
  }
  return res.text();
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
  /** The session's chosen agent; null means no agent. */
  agent_id: string | null;
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
  /** For assistant messages: the agent version of the run that last wrote it. */
  agent: MessageAgent | null;
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
    agent: RunAgent | null;
    /** The message being written now; null while a tool runs. */
    message: {
      messageId: string;
      continuing: boolean;
      content: ContentBlock[];
    } | null;
    /** Approval requests waiting for an answer. */
    approvals: ApprovalRequest[];
    /** Forms waiting for an answer (input forms design). */
    inputs: InputRequest[];
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
  /** The router model used for embeddings; empty: keyword search only. */
  embeddingModel: string;
  /** Renames new sessions after their first message. */
  autoRename: boolean;
  /** Where the title comes from. */
  autoRenameSource: "model" | "message";
  /** The router model that writes titles; empty: the session's model. */
  titleModel: string;
  /** The system prompt of the title call. */
  titlePrompt: string;
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

/**
 * Where files and memory notes live (files and memory design, section 3.3).
 */
export type EntryScope =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "session"; id: string };

/** The query key prefix for a scope's files or notes. */
export const entriesKey = (s: EntryScope, kind?: EntryKind) => [
  "entries",
  s.scope,
  s.scope === "global" ? null : s.id,
  ...(kind ? [kind] : []),
];

const entriesBase = (s: EntryScope, kind: EntryKind) =>
  `${
    s.scope === "global"
      ? "/api/global"
      : s.scope === "project"
        ? `/api/projects/${s.id}`
        : `/api/sessions/${s.id}`
  }/${kind === "file" ? "files" : "notes"}`;

/** A file or note. For a note, `key` is its id. */
export interface Entry {
  key: string;
  /** Files only. */
  type?: FileType;
  /** For a deleted entry, its last value. */
  value: string;
  updatedAt: string;
  deleted: boolean;
}

export interface EntryVersion {
  seq: number;
  type?: FileType;
  /** For a deletion, the value at the time. */
  value: string;
  deleted: boolean;
  by: "user" | "model";
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface EntryDetail extends Entry {
  versions: EntryVersion[];
}

/** Sent with a message or continue; they become the session's choices. */
export interface Choices {
  model?: string;
  reasoningEffort?: string;
  /** Null: no agent. */
  agentId?: string | null;
}

/** An agent version as a message shows it. */
export interface MessageAgent {
  id: string;
  version: number;
  /** Its name in that version. */
  name: string;
  /** Null: global. */
  projectId: string | null;
}

export type ToolMode = "allow" | "deny";

/** What each version of an agent holds. */
export interface AgentContent {
  name: string;
  description: string;
  prompt: string;
  /** "allow": only `tools`; "deny": every tool but `tools`. */
  toolMode: ToolMode;
  tools: string[];
}

export interface Agent extends AgentContent {
  id: string;
  /** Null: global. */
  projectId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface AgentVersion extends AgentContent {
  seq: number;
  /** A deletion; the content is what the agent had then. */
  deleted: boolean;
  createdAt: string;
}

export interface AgentDetail extends Agent {
  versions: AgentVersion[];
}

/** Where agents live: global, or a project. */
export type AgentScope = { scope: "global" } | { scope: "project"; id: string };

/** The query key prefix for a scope's agents. */
export const agentsKey = (s: AgentScope) => [
  "agents",
  s.scope,
  s.scope === "global" ? null : s.id,
];

const agentsBase = (s: AgentScope) =>
  s.scope === "global" ? "/api/global/agents" : `/api/projects/${s.id}/agents`;

/** An agent a session can pick, labelled with its scope. */
export interface PickableAgent {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global";
}

/** A 409 from an import whose name is taken. */
export interface ImportConflict {
  agentId: string;
  deleted: boolean;
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
    choices: {
      model?: string | null;
      reasoningEffort?: string | null;
      agentId?: string | null;
    },
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
  answerApproval: (runId: string, requestId: string, answer: ApprovalAnswer) =>
    request<{ ok: true }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}`,
      answer,
    ),
  /** Answers a form: its answers, or skipped. */
  answerInput: (runId: string, requestId: string, answer: InputAnswer) =>
    request<{ ok: true }>(
      "POST",
      `/api/runs/${runId}/inputs/${encodeURIComponent(requestId)}`,
      answer,
    ),
  listTools: () => request<ToolView[]>("GET", "/api/tools"),
  setToolAsks: (name: string, ask: boolean) =>
    request<ToolView>(
      "PUT",
      `/api/tools/${encodeURIComponent(name)}/approval`,
      { ask },
    ),
  listEntries: (s: EntryScope, kind: EntryKind, deleted: boolean) =>
    request<Entry[]>(
      "GET",
      `${entriesBase(s, kind)}${deleted ? "?deleted=true" : ""}`,
    ),
  getEntry: (s: EntryScope, kind: EntryKind, key: string) =>
    request<EntryDetail>(
      "GET",
      `${entriesBase(s, kind)}/${encodeURIComponent(key)}`,
    ),
  /** Creates or replaces a file. */
  writeFile: (s: EntryScope, key: string, type: FileType, value: string) =>
    request<EntryDetail>(
      "PUT",
      `${entriesBase(s, "file")}/${encodeURIComponent(key)}`,
      { type, value },
    ),
  /** Changes a note's text; the user cannot create notes. */
  editNote: (s: EntryScope, id: string, text: string) =>
    request<EntryDetail>(
      "PATCH",
      `${entriesBase(s, "note")}/${encodeURIComponent(id)}`,
      { text },
    ),
  deleteEntry: (s: EntryScope, kind: EntryKind, key: string) =>
    request<unknown>(
      "DELETE",
      `${entriesBase(s, kind)}/${encodeURIComponent(key)}`,
    ),
  /** Makes an earlier version current; also restores a deleted entry. */
  restoreEntry: (s: EntryScope, kind: EntryKind, key: string, seq: number) =>
    request<EntryDetail>(
      "POST",
      `${entriesBase(s, kind)}/${encodeURIComponent(key)}/restore`,
      { seq },
    ),
  listAgents: (s: AgentScope, deleted: boolean) =>
    request<Agent[]>(
      "GET",
      `${agentsBase(s)}${deleted ? "?deleted=true" : ""}`,
    ),
  getAgent: (id: string) => request<AgentDetail>("GET", `/api/agents/${id}`),
  createAgent: (s: AgentScope, c: AgentContent) =>
    request<AgentDetail>("POST", agentsBase(s), c),
  /** Saves a new version. */
  saveAgent: (id: string, c: AgentContent) =>
    request<AgentDetail>("PUT", `/api/agents/${id}`, c),
  deleteAgent: (id: string) => request<unknown>("DELETE", `/api/agents/${id}`),
  /** Makes an earlier version current; also restores a deleted agent. */
  restoreAgent: (id: string, seq: number) =>
    request<AgentDetail>("POST", `/api/agents/${id}/restore`, { seq }),
  getAgentVersion: (id: string, seq: number) =>
    request<AgentVersion & { agentId: string; projectId: string | null }>(
      "GET",
      `/api/agents/${id}/versions/${seq}`,
    ),
  exportAgent: (id: string) => requestText(`/api/agents/${id}/export`),
  /** 409 with an `ImportConflict` body when the name is taken. */
  importAgent: (s: AgentScope, markdown: string, replace: boolean) =>
    request<{ agent: AgentDetail; warnings: string[] }>(
      "POST",
      `${agentsBase(s)}/import`,
      { markdown, ...(replace ? { replace: true } : {}) },
    ),
  sessionAgents: (sessionId: string) =>
    request<PickableAgent[]>("GET", `/api/sessions/${sessionId}/agents`),
  /** The tools an agent can select (all but the files and memory tools). */
  agentTools: () =>
    request<{ name: string; description: string }[]>("GET", "/api/agent-tools"),
  getSettings: () => request<SettingsView>("GET", "/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<SettingsView>("PUT", "/api/settings", patch),
};

/** The app-wide event stream (agents.changed). */
export function appEventsUrl(): string {
  return `/api/events?${new URLSearchParams({ token: token ?? "" }).toString()}`;
}

export function eventsUrl(sessionId: string, lastEventId: number): string {
  const q = new URLSearchParams({
    token: token ?? "",
    lastEventId: String(lastEventId),
  });
  return `/api/sessions/${sessionId}/events?${q.toString()}`;
}
