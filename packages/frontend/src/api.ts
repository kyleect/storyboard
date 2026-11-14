import type {
  ApprovalAnswer,
  BlobRef,
  ApprovalRequest,
  ContentBlock,
  ControlResult,
  DataInfo,
  DataView,
  MediaType,
  InputAnswer,
  InputRequest,
  Message,
  ProjectColor,
  RunAgent,
  SchemaInfo,
  Selection,
  StoredEvent,
  ToolDefinition,
  ToolGroup,
  Usage,
} from "@harness/core";
import type { ToolGrant, ToolMode } from "./lib/tool-grant";

const TOKEN_KEY = "harness.token";

function readToken(): string | null {
  const match = /(?:^|[#&])token=([0-9a-f]+)/.exec(window.location.hash);

  if (match?.[1]) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // storage can be unavailable
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

window.addEventListener("hashchange", () => {
  if (/(?:^|[#&])token=[0-9a-f]+/.test(window.location.hash)) {
    window.location.reload();
  }
});

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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

  return readJson<T>(res);
}

async function requestFile<T>(
  path: string,
  file: Blob,
  mediaType: string,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? ""}`,
      "content-type": mediaType,
    },
    body: file,
  });

  return readJson<T>(res);
}

async function readJson<T>(res: Response): Promise<T> {
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
  model: string | null;
  reasoning_effort: string | null;
  trashed_at: string | null;
  project_id: string | null;
  /** 1 when it went to the trash because its project did. */
  trashed_with_project: number;
  agent_id: string | null;
}

export interface SessionListItem extends Session {
  usage: Usage | null;
  unread: boolean;
}

export interface SessionTableItem extends SessionListItem {
  agents: { id: string; name: string }[];
  running: boolean;
}

export interface ActiveRun {
  runId: string;
  sessionId: string;
  sessionTitle: string;
  parentRunId: string | null;
  agentName: string | null;
  waiting: boolean;
}

export interface SessionPage {
  items: SessionTableItem[];
  total: number;
}

export interface SessionPageQuery {
  projectId: string | null;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
}

export interface TrashSessionsResult {
  trashed: string[];
  refused: { id: string; error: string }[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  last_used_at: string;
  trashed_at: string | null;
  default_agent_id: string | null;
  system_prompt: string;
  color: ProjectColor | null;
}

export interface Trash {
  projects: (Project & { sessions: Session[] })[];
  sessions: Session[];
  branches: TrashedBranch[];
}

export interface TrashedBranch {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  preview: string;
  trashedAt: string;
  messages: number;
}

export interface StoredMessage {
  id: string;
  message: Message;
  model: string | null;
  reasoningEffort: string | null;
  agent: MessageAgent | null;
  usage: Usage | null;
  runId: string | null;
  parentCallId: string | null;
  parentId: string | null;
  branches: { ids: string[]; index: number } | null;
}

export interface ActiveRunSnapshot {
  runId: string;
  model: string | null;
  reasoningEffort: string | null;
  agent: RunAgent | null;
  message: {
    messageId: string;
    continuing: boolean;
    content: ContentBlock[];
  } | null;
  approvals: ApprovalRequest[];
  inputs: InputRequest[];
  userMessages: string[];
}

export interface ChildRunSnapshot extends ActiveRunSnapshot {
  parentRunId: string;
  parentCallId: string;
}

export interface SessionDetail {
  session: Session;
  project: Project | null;
  messages: StoredMessage[];
  branching: Branching;
  forkedFrom: ForkedFrom | null;
  subagentUsage: Usage | null;
  lastEventId: number;
  activeRun: ActiveRunSnapshot | null;
  childRuns: ChildRunSnapshot[];
}

export interface ForkedFrom {
  id: string;
  title: string;
  state: "live" | "trashed" | "gone";
}

export interface Branching {
  points: string[];
  editable: string[];
  regenerate: string | null;
  continuations: { id: string; role: Message["role"]; preview: string }[];
}

export interface EditResult {
  messageId: string;
  mode: "branch" | "in_place";
  runId: string | null;
}

export interface DebugRun {
  id: string;
  parentRunId: string | null;
  parentCallId: string | null;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agent: { id: string; version: number } | null;
  usage: unknown;
  error: string | null;
  systemPrompt: string | null;
  tools: ToolDefinition[] | null;
  request: "recorded" | "not_recorded";
}

export type DebugMessage = StoredMessage & {
  createdAt: string | null;
  active: boolean;
  trashed: boolean;
};

export interface SessionDebug {
  format: 2;
  exportedAt: string;
  session: Session;
  project: Project | null;
  runs: DebugRun[];
  messages: DebugMessage[];
  events: StoredEvent[];
}

export interface ToolView {
  name: string;
  description: string;
  group: ToolGroup;
  askByDefault: boolean;
  ask: boolean;
  fixed: boolean;
  alwaysOn: boolean;
  alwaysOnByDefault: boolean;
  off: boolean;
  needsReview: boolean;
  usedByAgents: string[];
}

export interface ToolGroupChange {
  ask?: boolean;
  alwaysOn?: boolean;
  off?: boolean;
}

export interface Settings {
  llamaServerUrl: string;
  model: string;
  reasoningEffort: string;
  port: number;
  loopLimit: number;
  copyLimit: number;
  skillFileMaxMib: number;
  skillMaxMib: number;
  skillMaxFiles: number;
  trashRetentionDays: number;
  embeddingModel: string;
  autoRename: boolean;
  autoRenameSource: "model" | "message";
  titleModel: string;
  titlePrompt: string;
  systemPrompt: string;
  skillsInstruction: string;
  schemasInstruction: string;
  toolsInstruction: string;
  dataInstruction: string;
  agentsInstruction: string;
  workspacesInstruction: string;
  filesInstruction: string;
  defaultAgentId: string;
  childReminders: number;
  childPrompt: string;
  subagentMessageLabel: string;
  subagentDepth: number;
  inlineMediaCap: number;
  keepMediaInline: boolean;
  workspaceReadCap: number;
  mediaDescriberAgent: string;
  mediaDescriberModel: string;
  editMode: "branch" | "in_place";
  answerAfterEdit: boolean;
}

export type DerivedState =
  "none" | "pending" | "generated" | "edited" | "failed";

export interface DerivedText {
  text: string;
  state: DerivedState;
}

export interface MediaDescriberInfo {
  enabled: boolean;
  files: number;
  empty: number;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  writable: boolean;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  ticks: string[];
}

export interface WorkspaceInput {
  name: string;
  path: string;
  writable: boolean;
}

export interface WorkspaceAttachment {
  workspace: Workspace;
  from: "project" | "session";
  readOnly: boolean;
  effectiveWritable: boolean;
}

export interface WorkspaceGrant {
  tool: string;
  workspaceId: string;
  workspaceName: string | null;
}

export type TickState = "all" | "some" | "none";

export interface WorkspaceTreeEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  state: TickState;
}

export interface WorkspaceTree {
  path: string;
  entries: WorkspaceTreeEntry[];
}

export interface WorkspaceIndexStatus {
  files: number;
  chunks: number;
  scanning: boolean;
  truncated: boolean;
  unavailable: boolean;
  lastScan: string | null;
}

export interface WorkspaceIndexView {
  ticks: string[];
  status: WorkspaceIndexStatus | null;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

export type WorkspaceOwner = "projects" | "sessions";

export interface SettingsView {
  effective: Settings;
  stored: Partial<Settings>;
  overriddenByEnv: Partial<Record<keyof Settings, string>>;
}

export interface ModelInfo {
  id: string;
  status?: string;
  failed?: boolean;
  inputModalities?: string[];
}

export type FileScope =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "session"; id: string };

const filesBase = (s: FileScope) =>
  `${
    s.scope === "global"
      ? "/api/global"
      : s.scope === "project"
        ? `/api/projects/${s.id}`
        : `/api/sessions/${s.id}`
  }/files`;

export interface UploadedFile {
  key: string;
  ref: string;
  mediaType: MediaType;
  size: number;
  blob: BlobRef;
  replaced: boolean;
}

export interface StoredFile {
  key: string;
  mediaType?: MediaType;
  value: string;
  blob?: BlobRef;
  updatedAt: string;
  deleted: boolean;
}

export interface FileVersion {
  seq: number;
  mediaType?: MediaType;
  value: string;
  blob?: BlobRef;
  deleted: boolean;
  by: "user" | "model";
  sessionId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface FileDetail extends StoredFile {
  versions: FileVersion[];
}

export interface Choices {
  model?: string;
  reasoningEffort?: string;
  agentId?: string | null;
}

export interface MessageAgent {
  id: string;
  version: number;
  name: string;
  projectId: string | null;
}

export type { ToolGrant, ToolMode };

export interface AgentContent {
  name: string;
  description: string;
  prompt: string;
  toolGrant: ToolGrant;
  toolApproval: Record<string, boolean>;
  childReminders: number | null;
  childPrompt: string | null;
  subagent: boolean;
}

export interface AgentToolInfo {
  name: string;
  description: string;
  group: ToolGroup;
  alwaysOn: boolean;
  off: boolean;
  needsReview: boolean;
}

export interface ToolApprovalInfo {
  name: string;
  description: string;
  group: ToolGroup;
  alwaysOn: boolean;
  ask: boolean;
  fixed: boolean;
}

export interface Agent extends AgentContent {
  id: string;
  newTools: string[];
  projectId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  builtin: boolean;
}

export interface AgentVersion extends AgentContent {
  seq: number;
  deleted: boolean;
  createdAt: string;
}

export interface ListedAgent extends Agent {
  isDefault: boolean;
}

export interface AgentDetail extends Agent {
  versions: AgentVersion[];
}

export type AgentScope = { scope: "global" } | { scope: "project"; id: string };

const agentsBase = (s: AgentScope) =>
  s.scope === "global" ? "/api/global/agents" : `/api/projects/${s.id}/agents`;

export interface PickableAgent {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global";
  isDefault: boolean;
  builtin: boolean;
}

export interface SkillContent {
  description: string;
  body: string;
}

export type SkillScopeName = "builtin" | "global" | "project" | "agent";

export interface Skill {
  id: string;
  name: string;
  description: string;
  scope: SkillScopeName;
  projectId: string | null;
  agentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface SkillFileInfo {
  path: string;
  mediaType: string;
  size: number;
  missing: boolean;
  hash: string | null;
}

export interface SkillWithFiles extends Skill {
  files: SkillFileInfo[];
}

export interface SkillImportPreview {
  name: string;
  description: string;
  instructions: string;
  files: { path: string; size: number }[];
  warnings: string[];
  clash: { id: string; deleted: boolean } | null;
}

export interface SkillVersion {
  seq: number;
  name: string;
  description: string;
  deleted: boolean;
  createdAt: string;
  fileCount: number;
  totalSize: number;
}

export interface SkillDetail extends Skill {
  body: string;
  files: SkillFileInfo[];
  versions: SkillVersion[];
}

export type SkillOwner =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "agent"; id: string };

const skillsBase = (o: SkillOwner) =>
  o.scope === "global"
    ? "/api/global/skills"
    : o.scope === "project"
      ? `/api/projects/${o.id}/skills`
      : `/api/agents/${o.id}/skills`;

export type DataOwner =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "agent"; id: string }
  | { scope: "session"; id: string };

const dataBase = (o: DataOwner) =>
  o.scope === "global"
    ? "/api/global/data"
    : o.scope === "project"
      ? `/api/projects/${o.id}/data`
      : o.scope === "agent"
        ? `/api/agents/${o.id}/data`
        : `/api/sessions/${o.id}/data`;

export type DataItem = DataInfo;

export interface DataVersion {
  seq: number;
  schemaVersion: number;
  name: string;
  description: string;
  value: unknown;
  deleted: boolean;
  author: "user" | "model";
  createdAt: string | null;
}

export interface DataDetail extends DataView {
  schema:
    | (SchemaInfo & {
        pinned: unknown;
        latest: unknown;
      })
    | null;
  versions: DataVersion[];
}

export type CopyTarget =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "agent"; id: string };

const schemasBase = (o: DataOwner) =>
  dataBase(o).replace(/\/data$/, "/schemas");

export interface SchemaDetail extends SchemaInfo {
  body: unknown;
  versions: { version: number; body: unknown }[];
  dataCount: number;
}

export interface SchemaContent {
  name: string;
  description: string;
  body: unknown;
}

export interface DataContent {
  name: string;
  description: string;
  value: unknown;
}

export interface ImportConflict {
  agentId: string;
  deleted: boolean;
}

export interface ErrorEntry {
  id: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
  messageId: string | null;
  callId: string | null;
  source: "tool" | "run";
  kind:
    | "tool_threw"
    | "tool_returned_error"
    | "unknown_tool"
    | "invalid_arguments"
    | "malformed_call"
    | "run_failed";
  toolName: string | null;
  message: string;
  details: Record<string, unknown> | null;
  stack: string | null;
  arguments: unknown;
  createdAt: string;
}

export interface ErrorFilter {
  sessionId?: string;
  projectId?: string;
  source?: "tool" | "run";
  tool?: string;
}

export interface ErrorFilterOptions {
  sessions: { id: string; title: string; projectId: string | null }[];
  projects: { id: string; name: string }[];
  tools: string[];
  runs: boolean;
}

export type McpState = "disabled" | "connecting" | "connected" | "failed";

export interface McpToolInfo {
  name: string;
  serverName: string;
  description: string;
}

export type McpConfig =
  | {
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      transport: "http";
      url: string;
      headers: Record<string, string>;
    };

export interface McpServerInput {
  name: string;
  enabled: boolean;
  config: McpConfig;
}

export interface ProfileView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  trashedAt: string | null;
  active: boolean;
}

export interface ProfileListing {
  active: string;
  profiles: ProfileView[];
  trashed: ProfileView[];
}

export interface McpServerView extends McpServerInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: {
    state: McpState;
    error: string | null;
    tools: McpToolInfo[];
  };
}

export interface UnreadSession {
  id: string;
  projectId: string | null;
}

export const api = {
  listErrors: (filter: ErrorFilter = {}) => {
    const q = new URLSearchParams(
      Object.entries(filter).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ).toString();

    return request<ErrorEntry[]>("GET", `/api/errors${q ? `?${q}` : ""}`);
  },
  errorFilters: () => request<ErrorFilterOptions>("GET", "/api/errors/filters"),
  clearErrors: (sessionId?: string) =>
    request<{ cleared: number }>(
      "DELETE",
      `/api/errors${
        sessionId ? `?${new URLSearchParams({ sessionId }).toString()}` : ""
      }`,
    ),
  listModels: () => request<ModelInfo[]>("GET", "/api/models"),
  loadModel: (model: string) =>
    request<
      { ok: true; alreadyRunning: boolean } | { ok: false; message: string }
    >("POST", "/api/models/load", { model }),
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
  contextSize: (model: string | undefined) =>
    request<{ contextSize: number } | { unavailable: string }>(
      "GET",
      `/api/models/context-size${
        model ? `?model=${encodeURIComponent(model)}` : ""
      }`,
    ),
  endReasoning: (runId: string) =>
    request<ControlResult>("POST", `/api/runs/${runId}/end-reasoning`),
  listSessions: (projectId: string | null) =>
    request<SessionListItem[]>(
      "GET",
      `/api/sessions${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      }`,
    ),
  listSessionsPage: (q: SessionPageQuery) => {
    const params = new URLSearchParams({
      direction: q.direction,
      page: String(q.page),
      pageSize: String(q.pageSize),
    });

    if (q.projectId) params.set("projectId", q.projectId);

    return request<SessionPage>("GET", `/api/sessions-page?${params}`);
  },
  listUnreadSessions: () =>
    request<{ sessions: UnreadSession[] }>("GET", "/api/sessions-unread/list"),
  listSessionIds: (projectId: string | null) =>
    request<{ sessions: { id: string; running: boolean }[] }>(
      "GET",
      `/api/sessions-page/ids${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      }`,
    ),
  listActiveRuns: () =>
    request<{ runs: ActiveRun[] }>("GET", "/api/runs/active"),
  trashSessions: (ids: readonly string[]) =>
    request<TrashSessionsResult>("POST", "/api/sessions/trash", { ids }),
  createSession: (projectId: string | null) =>
    request<Session>("POST", "/api/sessions", projectId ? { projectId } : {}),
  getSession: (id: string) =>
    request<SessionDetail>("GET", `/api/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    request<Session>("PATCH", `/api/sessions/${id}`, { title }),
  trashSession: (id: string) =>
    request<Session>("POST", `/api/sessions/${id}/trash`),
  markSessionSeen: (id: string) =>
    request<Session>("POST", `/api/sessions/${id}/seen`),
  unreadSessionCount: () =>
    request<{ count: number }>("GET", "/api/sessions-unread"),
  restoreSession: (id: string, project?: "all" | "only") =>
    request<Session>(
      "POST",
      `/api/sessions/${id}/restore`,
      project ? { project } : {},
    ),
  deleteSession: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/sessions/${id}`),
  getTrash: () => request<Trash>("GET", "/api/trash"),
  emptyTrash: () =>
    request<{
      purged: { projects: number; sessions: number; branches: number };
    }>("DELETE", "/api/trash"),
  restoreBranch: (messageId: string) =>
    request<{ ok: true }>("POST", `/api/trash/branches/${messageId}/restore`),
  deleteTrashedBranch: (messageId: string) =>
    request<{ ok: true }>("DELETE", `/api/trash/branches/${messageId}`),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  getProject: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  createProject: (p: {
    name: string;
    description: string;
    color?: ProjectColor | null;
  }) => request<Project>("POST", "/api/projects", p),
  updateProject: (
    id: string,
    fields: {
      name?: string;
      description?: string;
      defaultAgentId?: string | null;
      systemPrompt?: string;
      color?: ProjectColor | null;
    },
  ) => request<Project>("PATCH", `/api/projects/${id}`, fields),
  trashProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/trash`),
  restoreProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/restore`),
  deleteProject: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/projects/${id}`),
  sendMessage: (
    id: string,
    content: string,
    choices: Choices,
    files: readonly string[] = [],
  ) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/messages`, {
      content,
      ...(files.length > 0 ? { files } : {}),
      ...choices,
    }),
  editMessage: (
    id: string,
    messageId: string,
    content: string,
    mode: "branch" | "in_place" | undefined,
    choices: Choices,
  ) =>
    request<EditResult>("PATCH", `/api/sessions/${id}/messages/${messageId}`, {
      content,
      ...(mode ? { mode } : {}),
      ...choices,
    }),
  regenerate: (id: string, choices: Choices) =>
    request<{ runId: string }>(
      "POST",
      `/api/sessions/${id}/regenerate`,
      choices,
    ),
  branchOff: (id: string, messageId: string, choices: Choices) =>
    request<{ runId: string | null }>("POST", `/api/sessions/${id}/branch`, {
      messageId,
      ...choices,
    }),
  forkSession: (id: string, messageId: string, title: string) =>
    request<Session>("POST", `/api/sessions/${id}/fork`, { messageId, title }),
  switchBranch: (id: string, messageId: string) =>
    request<{ tipId: string }>("POST", `/api/sessions/${id}/switch`, {
      messageId,
    }),
  deleteBranch: (id: string, messageId: string) =>
    request<{ tipId: string }>(
      "DELETE",
      `/api/sessions/${id}/branches/${messageId}`,
    ),
  uploadFile: (
    s: FileScope,
    file: File,
    mediaType: string,
    options: { name?: string; replace?: boolean } = {},
  ) => {
    const name = options.name ?? file.name;
    const query = [
      ...(name ? [`name=${encodeURIComponent(name)}`] : []),
      ...(options.replace ? ["replace=true"] : []),
    ].join("&");

    return requestFile<UploadedFile>(
      `${filesBase(s)}${query ? `?${query}` : ""}`,
      file,
      mediaType,
    );
  },
  blobUrl: async (hash: string): Promise<string> => {
    const res = await fetch(`/api/blobs/${hash}`, {
      headers: { authorization: `Bearer ${token ?? ""}` },
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      throw new ApiError(data.error ?? res.statusText, res.status, data);
    }

    return URL.createObjectURL(await res.blob());
  },
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
  checkApproval: (runId: string, requestId: string, selection: Selection) =>
    request<{ errors: string[]; stale: boolean }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}/check`,
      { selection },
    ),
  refreshApproval: (runId: string, requestId: string) =>
    request<{ request: ApprovalRequest }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}/refresh`,
    ).then((r) => r.request),
  answerInput: (runId: string, requestId: string, answer: InputAnswer) =>
    request<{ ok: true }>(
      "POST",
      `/api/runs/${runId}/inputs/${encodeURIComponent(requestId)}`,
      answer,
    ),
  sendRunMessage: (runId: string, text: string) =>
    request<{ waiting: number }>("POST", `/api/runs/${runId}/messages`, {
      text,
    }),
  listWorkspaces: (deleted = false) =>
    request<Workspace[]>("GET", `/api/workspaces?deleted=${deleted}`),
  createWorkspace: (input: WorkspaceInput) =>
    request<Workspace>("POST", "/api/workspaces", input),
  saveWorkspace: (id: string, input: WorkspaceInput) =>
    request<Workspace>(
      "PUT",
      `/api/workspaces/${encodeURIComponent(id)}`,
      input,
    ),
  trashWorkspace: (id: string) =>
    request<Workspace>("DELETE", `/api/workspaces/${encodeURIComponent(id)}`),
  restoreWorkspace: (id: string) =>
    request<Workspace>(
      "POST",
      `/api/workspaces/${encodeURIComponent(id)}/restore`,
    ),
  listAttachedWorkspaces: (owner: WorkspaceOwner, id: string) =>
    request<WorkspaceAttachment[]>(
      "GET",
      `/api/${owner}/${encodeURIComponent(id)}/workspaces`,
    ),
  attachWorkspace: (
    owner: WorkspaceOwner,
    id: string,
    workspaceId: string,
    readOnly: boolean,
  ) =>
    request<unknown>(
      "PUT",
      `/api/${owner}/${encodeURIComponent(id)}/workspaces/${encodeURIComponent(workspaceId)}`,
      { readOnly },
    ),
  detachWorkspace: (owner: WorkspaceOwner, id: string, workspaceId: string) =>
    request<unknown>(
      "DELETE",
      `/api/${owner}/${encodeURIComponent(id)}/workspaces/${encodeURIComponent(workspaceId)}`,
    ),
  getWorkspaceTree: (id: string, path = "") =>
    request<WorkspaceTree>(
      "GET",
      `/api/workspaces/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(path)}`,
    ),
  getWorkspaceIndex: (id: string) =>
    request<WorkspaceIndexView>(
      "GET",
      `/api/workspaces/${encodeURIComponent(id)}/index`,
    ),
  toggleWorkspaceTick: (id: string, path: string, on: boolean) =>
    request<WorkspaceIndexView>(
      "POST",
      `/api/workspaces/${encodeURIComponent(id)}/ticks/toggle`,
      { path, on },
    ),
  rescanWorkspace: (id: string) =>
    request<unknown>(
      "POST",
      `/api/workspaces/${encodeURIComponent(id)}/rescan`,
    ),
  listWorkspaceGrants: () =>
    request<WorkspaceGrant[]>("GET", "/api/workspace-grants"),
  revokeWorkspaceGrant: (tool: string, workspaceId: string) =>
    request<unknown>("DELETE", "/api/workspace-grants", { tool, workspaceId }),
  listDirs: (path?: string) =>
    request<DirListing>(
      "GET",
      `/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  workspaceFileUrl: async (
    sessionId: string,
    ref: string,
  ): Promise<{ url: string; mediaType: string }> => {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace-file?ref=${encodeURIComponent(ref)}`,
      { headers: { authorization: `Bearer ${token ?? ""}` } },
    );

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      throw new ApiError(data.error ?? res.statusText, res.status, data);
    }

    const blob = await res.blob();

    return { url: URL.createObjectURL(blob), mediaType: blob.type };
  },
  listProfiles: () => request<ProfileListing>("GET", "/api/profiles"),
  createProfile: (name: string) =>
    request<ProfileView>("POST", "/api/profiles", { name }),
  renameProfile: (id: string, name: string) =>
    request<ProfileView>("PUT", `/api/profiles/${encodeURIComponent(id)}`, {
      name,
    }),
  trashProfile: (id: string) =>
    request<ProfileView>(
      "POST",
      `/api/profiles/${encodeURIComponent(id)}/trash`,
    ),
  restoreProfile: (id: string) =>
    request<ProfileView>(
      "POST",
      `/api/profiles/${encodeURIComponent(id)}/restore`,
    ),
  switchProfile: (id: string) =>
    request<ProfileListing>(
      "POST",
      `/api/profiles/${encodeURIComponent(id)}/switch`,
    ),
  listMcpServers: () => request<McpServerView[]>("GET", "/api/mcp/servers"),
  createMcpServer: (input: McpServerInput) =>
    request<McpServerView>("POST", "/api/mcp/servers", input),
  saveMcpServer: (id: string, input: McpServerInput) =>
    request<McpServerView>(
      "PUT",
      `/api/mcp/servers/${encodeURIComponent(id)}`,
      input,
    ),
  deleteMcpServer: (id: string) =>
    request<unknown>("DELETE", `/api/mcp/servers/${encodeURIComponent(id)}`),
  reconnectMcpServer: (id: string) =>
    request<McpServerView>(
      "POST",
      `/api/mcp/servers/${encodeURIComponent(id)}/reconnect`,
    ),
  listTools: () => request<ToolView[]>("GET", "/api/tools"),
  setToolAsks: (name: string, ask: boolean) =>
    request<ToolView>(
      "PUT",
      `/api/tools/${encodeURIComponent(name)}/approval`,
      { ask },
    ),
  setToolAlwaysOn: (name: string, alwaysOn: boolean) =>
    request<ToolView>(
      "PUT",
      `/api/tools/${encodeURIComponent(name)}/always-on`,
      { alwaysOn },
    ),
  setToolOff: (name: string, off: boolean) =>
    request<ToolView>("PUT", `/api/tools/${encodeURIComponent(name)}/off`, {
      off,
    }),
  setToolGroup: (group: ToolGroup, change: ToolGroupChange) =>
    request<ToolView[]>(
      "PUT",
      `/api/tool-groups/${encodeURIComponent(group)}`,
      change,
    ),
  listFiles: (s: FileScope, deleted: boolean) =>
    request<StoredFile[]>(
      "GET",
      `${filesBase(s)}${deleted ? "?deleted=true" : ""}`,
    ),
  getFile: (s: FileScope, key: string) =>
    request<FileDetail>("GET", `${filesBase(s)}/${encodeURIComponent(key)}`),
  writeFile: (s: FileScope, key: string, mediaType: MediaType, value: string) =>
    request<FileDetail>("PUT", `${filesBase(s)}/${encodeURIComponent(key)}`, {
      mediaType,
      value,
    }),
  listFolders: (s: FileScope) =>
    request<string[]>("GET", `${filesBase(s).replace(/files$/, "folders")}`),
  createFolder: (s: FileScope, path: string) =>
    request<{ path: string; created: boolean }>(
      "POST",
      filesBase(s).replace(/files$/, "folders"),
      { path },
    ),
  renameFolder: (s: FileScope, path: string, newPath: string) =>
    request<{ path: string }>(
      "POST",
      `${filesBase(s).replace(/files$/, "folders")}/rename`,
      { path, newPath },
    ),
  deleteFolder: (s: FileScope, path: string) =>
    request<unknown>(
      "POST",
      `${filesBase(s).replace(/files$/, "folders")}/delete`,
      { path },
    ),
  deleteFile: (s: FileScope, key: string) =>
    request<unknown>("DELETE", `${filesBase(s)}/${encodeURIComponent(key)}`),
  restoreFile: (s: FileScope, key: string, seq: number) =>
    request<FileDetail>(
      "POST",
      `${filesBase(s)}/${encodeURIComponent(key)}/restore`,
      { seq },
    ),
  listAgents: (s: AgentScope, deleted: boolean) =>
    request<ListedAgent[]>(
      "GET",
      `${agentsBase(s)}${deleted ? "?deleted=true" : ""}`,
    ),
  getAgent: (id: string) => request<AgentDetail>("GET", `/api/agents/${id}`),
  createAgent: (s: AgentScope, c: AgentContent) =>
    request<AgentDetail>("POST", agentsBase(s), c),
  saveAgent: (id: string, c: AgentContent) =>
    request<AgentDetail>("PUT", `/api/agents/${id}`, c),
  deleteAgent: (id: string) => request<unknown>("DELETE", `/api/agents/${id}`),
  restoreAgent: (id: string, seq: number) =>
    request<AgentDetail>("POST", `/api/agents/${id}/restore`, { seq }),
  getAgentVersion: (id: string, seq: number) =>
    request<AgentVersion & { agentId: string; projectId: string | null }>(
      "GET",
      `/api/agents/${id}/versions/${seq}`,
    ),
  exportAgent: (id: string) => requestText(`/api/agents/${id}/export`),
  importAgent: (s: AgentScope, markdown: string, replace: boolean) =>
    request<{ agent: AgentDetail; warnings: string[] }>(
      "POST",
      `${agentsBase(s)}/import`,
      { markdown, ...(replace ? { replace: true } : {}) },
    ),
  sessionAgents: (sessionId: string) =>
    request<PickableAgent[]>("GET", `/api/sessions/${sessionId}/agents`),
  agentTools: () => request<AgentToolInfo[]>("GET", "/api/agent-tools"),
  agentToolApprovals: () =>
    request<ToolApprovalInfo[]>("GET", "/api/agent-tool-approvals"),
  listSkills: (o: SkillOwner, deleted: boolean) =>
    request<Skill[]>(
      "GET",
      `${skillsBase(o)}${deleted ? "?deleted=true" : ""}`,
    ),
  getSkill: (id: string) => request<SkillDetail>("GET", `/api/skills/${id}`),
  createSkill: (o: SkillOwner, c: SkillContent & { name: string }) =>
    request<SkillDetail>("POST", skillsBase(o), c),
  saveSkill: (id: string, c: SkillContent) =>
    request<SkillDetail>("PUT", `/api/skills/${id}`, c),
  listSkillTree: (o: SkillOwner, deleted: boolean) =>
    request<SkillWithFiles[]>(
      "GET",
      `${skillsBase(o)}?files=true${deleted ? "&deleted=true" : ""}`,
    ),
  putSkillFile: (id: string, path: string, value: string) =>
    request<SkillDetail>(
      "PUT",
      `/api/skills/${id}/file?path=${encodeURIComponent(path)}`,
      { value },
    ),
  putSkillFileBytes: async (id: string, path: string, file: Blob) => {
    const res = await fetch(
      `/api/skills/${id}/file/raw?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token ?? ""}`,
          "content-type": "application/octet-stream",
        },
        body: file,
      },
    );

    return readJson<SkillDetail>(res);
  },
  deleteSkillPath: (id: string, path: string) =>
    request<SkillDetail>(
      "DELETE",
      `/api/skills/${id}/file?path=${encodeURIComponent(path)}`,
    ),
  moveSkillPath: (id: string, from: string, to: string) =>
    request<SkillDetail>("POST", `/api/skills/${id}/move`, { from, to }),
  copySkill: (o: SkillOwner, id: string) =>
    request<SkillDetail>("POST", `${skillsBase(o)}/copy`, { id }),
  previewSkillImport: async (o: SkillOwner, zip: Blob) => {
    const res = await fetch(`${skillsBase(o)}/import/preview`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        "content-type": "application/zip",
      },
      body: zip,
    });

    return readJson<SkillImportPreview>(res);
  },
  importSkill: async (
    o: SkillOwner,
    zip: Blob,
    resolve?: { resolve: "replace" } | { resolve: "rename"; name: string },
  ) => {
    const query = !resolve
      ? ""
      : resolve.resolve === "replace"
        ? "?resolve=replace"
        : `?resolve=rename&name=${encodeURIComponent(resolve.name)}`;
    const res = await fetch(`${skillsBase(o)}/import${query}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        "content-type": "application/zip",
      },
      body: zip,
    });

    return readJson<SkillDetail & { warnings: string[] }>(res);
  },
  exportSkill: async (id: string, seq?: number): Promise<Blob> => {
    const res = await fetch(
      `/api/skills/${id}/export${seq === undefined ? "" : `?seq=${seq}`}`,
      { headers: { authorization: `Bearer ${token ?? ""}` } },
    );

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      throw new ApiError(data.error ?? res.statusText, res.status, data);
    }

    return res.blob();
  },
  renameSkill: (id: string, name: string) =>
    request<SkillDetail>("POST", `/api/skills/${id}/rename`, { name }),
  getSkillFile: (id: string, path: string, seq?: number) =>
    request<SkillFileInfo & { value: string }>(
      "GET",
      `/api/skills/${id}/file?path=${encodeURIComponent(path)}${seq === undefined ? "" : `&seq=${seq}`}`,
    ),
  deleteSkill: (id: string) => request<unknown>("DELETE", `/api/skills/${id}`),
  restoreSkill: (id: string, seq: number) =>
    request<SkillDetail>("POST", `/api/skills/${id}/restore`, { seq }),
  listData: (o: DataOwner, deleted: boolean) =>
    request<{ readOnly: string | null; data: DataItem[] }>(
      "GET",
      `${dataBase(o)}${deleted ? "?deleted=true" : ""}`,
    ),
  dataSchemas: (o: DataOwner) =>
    request<SchemaInfo[]>("GET", `${dataBase(o)}/schemas`),
  schemaBody: (o: DataOwner, schemaId: string) =>
    request<SchemaInfo & { body: unknown }>(
      "GET",
      `${dataBase(o)}/schemas/${encodeURIComponent(schemaId)}`,
    ).then((r) => r.body),
  getData: (o: DataOwner, id: string) =>
    request<DataDetail>("GET", `${dataBase(o)}/${encodeURIComponent(id)}`),
  createData: (o: DataOwner, schemaId: string, c: DataContent) =>
    request<DataView>("POST", dataBase(o), { schemaId, ...c }),
  saveData: (o: DataOwner, id: string, c: DataContent) =>
    request<DataView>("PUT", `${dataBase(o)}/${encodeURIComponent(id)}`, c),
  migrateData: (o: DataOwner, id: string, value: unknown) =>
    request<DataView>(
      "POST",
      `${dataBase(o)}/${encodeURIComponent(id)}/migrate`,
      { value },
    ),
  deleteData: (o: DataOwner, id: string) =>
    request<unknown>("DELETE", `${dataBase(o)}/${encodeURIComponent(id)}`),
  restoreData: (o: DataOwner, id: string, seq: number) =>
    request<DataView>(
      "POST",
      `${dataBase(o)}/${encodeURIComponent(id)}/restore`,
      { seq },
    ),
  listSchemas: (o: DataOwner, deleted: boolean) =>
    request<{ readOnly: string | null; schemas: SchemaInfo[] }>(
      "GET",
      `${schemasBase(o)}${deleted ? "?deleted=true" : ""}`,
    ),
  getSchema: (o: DataOwner, id: string) =>
    request<SchemaDetail>("GET", `${schemasBase(o)}/${encodeURIComponent(id)}`),
  createSchema: (o: DataOwner, c: SchemaContent) =>
    request<SchemaInfo>("POST", schemasBase(o), c),
  saveSchema: (o: DataOwner, id: string, c: SchemaContent) =>
    request<SchemaInfo>(
      "PUT",
      `${schemasBase(o)}/${encodeURIComponent(id)}`,
      c,
    ),
  deleteSchema: (o: DataOwner, id: string) =>
    request<{ data: number }>(
      "DELETE",
      `${schemasBase(o)}/${encodeURIComponent(id)}`,
    ),
  restoreSchema: (o: DataOwner, id: string) =>
    request<SchemaInfo>(
      "POST",
      `${schemasBase(o)}/${encodeURIComponent(id)}/restore`,
    ),
  copySchema: (o: DataOwner, id: string, to: CopyTarget, name: string) =>
    request<SchemaInfo>(
      "POST",
      `${schemasBase(o)}/${encodeURIComponent(id)}/copy`,
      { to, name },
    ),
  getSessionDebug: (id: string) =>
    request<SessionDebug>("GET", `/api/sessions/${id}/debug`),
  getDerivedText: (hash: string) =>
    request<DerivedText>("GET", `/api/blobs/${hash}/derived-text`),
  setDerivedText: (hash: string, text: string) =>
    request<DerivedText>("PUT", `/api/blobs/${hash}/derived-text`, { text }),
  describeFile: (hash: string) =>
    request<DerivedText>("POST", `/api/blobs/${hash}/describe`),
  getMediaDescriber: () =>
    request<MediaDescriberInfo>("GET", "/api/media-describer"),
  regenerateDescriptions: (mode: "empty" | "all") =>
    request<{ queued: number }>("POST", "/api/media-describer/regenerate", {
      mode,
    }),
  getMediaChoices: (id: string) =>
    request<{ ref: string; keep: boolean }[]>(
      "GET",
      `/api/sessions/${id}/media-choices`,
    ),
  setMediaChoice: (id: string, ref: string, keep: boolean | null) =>
    request<{ ref: string; keep: boolean | null }>(
      "PUT",
      `/api/sessions/${id}/media-choices`,
      { ref, keep },
    ),
  getSettings: () => request<SettingsView>("GET", "/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<SettingsView>("PUT", "/api/settings", patch),
};

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
