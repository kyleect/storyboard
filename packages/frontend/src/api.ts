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
  RunAgent,
  SchemaInfo,
  Selection,
  StoredEvent,
  ToolDefinition,
  ToolGroup,
  Usage,
} from "@harness/core";
import type { ToolGrant, ToolMode } from "./tool-grant";

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
  return readJson<T>(res);
}

/** A request whose body is a file, sent as it is with its media type. */
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
  /** The latest message is an assistant reply the user has not seen. */
  unread: boolean;
}

/** A session in the Sessions page's table. */
export interface SessionTableItem extends SessionListItem {
  /** The agents that ran in it, subagents included; empty when none did. */
  agents: { id: string; name: string }[];
  /** True while a run is in progress in it. */
  running: boolean;
}

/** A run in progress in any session, for the activity indicators. */
export interface ActiveRun {
  runId: string;
  sessionId: string;
  sessionTitle: string;
  /** For a subagent's run: the run that started it; null: a top-level run. */
  parentRunId: string | null;
  agentName: string | null;
  /** True while the run waits for an approval or a form. */
  waiting: boolean;
}

/** One page of the Sessions page's table. */
export interface SessionPage {
  items: SessionTableItem[];
  /** How many sessions there are in all, not only on this page. */
  total: number;
}

/** What the Sessions page asks for: one page of a project's sessions. */
export interface SessionPageQuery {
  /** A project, or null for the standalone sessions. */
  projectId: string | null;
  /** By creation time: "desc" is newest first. */
  direction: "asc" | "desc";
  /** From 1. */
  page: number;
  pageSize: number;
}

/** What moving several sessions to the trash did. */
export interface TrashSessionsResult {
  trashed: string[];
  /** The sessions that could not be moved, and why. */
  refused: { id: string; error: string }[];
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
  /** The agent new sessions start with; null: none. */
  default_agent_id: string | null;
  /** Sent after the global system prompt; empty when there is none. */
  system_prompt: string;
}

/** Everything in the trash. */
export interface Trash {
  /** Each with the sessions trashed together with it. */
  projects: (Project & { sessions: Session[] })[];
  /** Sessions trashed on their own. */
  sessions: Session[];
  /** Deleted branches of sessions that are not themselves in the trash. */
  branches: TrashedBranch[];
}

/** A deleted branch: its first message, and everything after it. */
export interface TrashedBranch {
  /** The first message of the branch. */
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  /** The first line of the branch's first message. */
  preview: string;
  trashedAt: string;
  /** How many messages the branch holds, nested branches included. */
  messages: number;
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
  /** The run that first wrote the message; null: none (a user message). */
  runId: string | null;
  /**
   * For a message of a subagent's run: the `start_subagent` call that
   * started that run. Null for the session's own messages.
   */
  parentCallId: string | null;
  /** The message before this one on its line; null for a first message. */
  parentId: string | null;
  /**
   * When this message has live siblings (other messages after the same
   * parent): their ids in creation order and this one's place. Null when it
   * has none, and for a subagent run's messages.
   */
  branches: { ids: string[]; index: number } | null;
}

/** An active run as a reconnecting client sees it. */
export interface ActiveRunSnapshot {
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
  /** Messages the user sent that the run has not read yet, oldest first. */
  userMessages: string[];
}

/** A subagent's run in progress, with the run and call that started it. */
export interface ChildRunSnapshot extends ActiveRunSnapshot {
  parentRunId: string;
  parentCallId: string;
}

export interface SessionDetail {
  session: Session;
  /** The session's project; null for a standalone session. */
  project: Project | null;
  messages: StoredMessage[];
  /** What the page needs to offer editing and branching. */
  branching: Branching;
  /** The session this one was forked from; null: it was not forked. */
  forkedFrom: ForkedFrom | null;
  /**
   * Tokens used by the session's finished subagent runs, summed over all
   * their model calls; null: none. Work done, not context occupancy.
   */
  subagentUsage: Usage | null;
  lastEventId: number;
  activeRun: ActiveRunSnapshot | null;
  /** Subagents' runs in progress. */
  childRuns: ChildRunSnapshot[];
}

/** Where a forked session came from, and whether that session is still there. */
export interface ForkedFrom {
  id: string;
  /** The title it had when forked. */
  title: string;
  state: "live" | "trashed" | "gone";
}

/** Where the session can be edited and branched (message editing plan). */
export interface Branching {
  /** Messages a branch or fork may start at: a request ending there is valid. */
  points: string[];
  /** The user's own messages, which can be edited. */
  editable: string[];
  /** The user message that started the turn Regenerate would redo; null: none. */
  regenerate: string | null;
  /** Live messages after the end of the line, such as after a branch off. */
  continuations: { id: string; role: Message["role"]; preview: string }[];
}

/** What editing a message did. */
export interface EditResult {
  /** The edited message: the copy, for a new branch. */
  messageId: string;
  mode: "branch" | "in_place";
  /** The run that answers it; null: none was started. */
  runId: string | null;
}

/** One run's request in a debugging export. */
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
  /** The system message as sent; null: none, or not recorded. */
  systemPrompt: string | null;
  /** The tools the run offered; null when not recorded. */
  tools: ToolDefinition[] | null;
  request: "recorded" | "not_recorded";
}

/**
 * A stored message with when it was created, and whether it is on the line
 * the session shows (`active`) or in a deleted branch (`trashed`). The export
 * holds every branch.
 */
export type DebugMessage = StoredMessage & {
  createdAt: string | null;
  active: boolean;
  trashed: boolean;
};

/** A session exported for debugging (`GET /api/sessions/:id/debug`). */
export interface SessionDebug {
  format: 2;
  exportedAt: string;
  session: Session;
  project: Project | null;
  runs: DebugRun[];
  messages: DebugMessage[];
  events: StoredEvent[];
}

/** A tool and how Settings has it (tool management design, decision 12). */
export interface ToolView {
  name: string;
  description: string;
  group: ToolGroup;
  askByDefault: boolean;
  ask: boolean;
  /** True for a tool that always asks: its setting cannot be changed. */
  fixed: boolean;
  /** Offered to every agent now: the setting, else the tool's default. */
  alwaysOn: boolean;
  /** The tool's own default for always on. */
  alwaysOnByDefault: boolean;
  /** Switched off for the whole harness. */
  off: boolean;
  /** Destructive or prompt-changing: a group grant does not cover it. */
  needsReview: boolean;
  /** The live agents that list the tool, by name. */
  usedByAgents: string[];
}

/** What a Settings change to a whole group can set. */
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
  /** The most model calls one run makes. */
  loopLimit: number;
  /** The most files one copy or move call may name. */
  copyLimit: number;
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
  /**
   * The global system prompt, before the project's and the agent's in
   * every chat run. Empty: none.
   */
  systemPrompt: string;
  /**
   * The wording that introduces the skill list: what
   * `{{skills_instruction}}` expands to, and what goes before the list where
   * no prompt places the skills. Empty: the list goes in alone.
   */
  skillsInstruction: string;
  /** The same for schemas: `{{schemas_instruction}}`. */
  schemasInstruction: string;
  /** The wording for the other lists: `{{tools_instruction}}` and so on. */
  toolsInstruction: string;
  dataInstruction: string;
  agentsInstruction: string;
  workspacesInstruction: string;
  filesInstruction: string;
  /**
   * The global agent a new session starts with when its project has no
   * default of its own. Empty: none.
   */
  defaultAgentId: string;
  /** Reminders a subagent gets before its last text is taken as its output. */
  childReminders: number;
  /** The line added to the end of a subagent's system message. */
  childPrompt: string;
  /** The line put before a message the user sends to a running subagent. */
  subagentMessageLabel: string;
  /** How deep subagents can nest; 0: subagents are off. */
  subagentDepth: number;
  /** The most kept images and audio files from earlier turns sent to the model. */
  inlineMediaCap: number;
  /** Keep earlier turns' media in view when nobody chose. */
  keepMediaInline: boolean;
  /** The most characters one workspace file read returns. */
  workspaceReadCap: number;
  /** The agent whose prompt writes the text of images and audio. Empty: off. */
  mediaDescriberAgent: string;
  /** The router model that runs it. Empty: off. */
  mediaDescriberModel: string;
  /**
   * What editing a message does by default: "branch" keeps the old message and
   * what followed on a branch; "in_place" overwrites the text.
   */
  editMode: "branch" | "in_place";
  /** Whether the model answers right after an edit that made a branch. */
  answerAfterEdit: boolean;
}

/** Where a file's text came from. */
export type DerivedState =
  "none" | "pending" | "generated" | "edited" | "failed";

/** The description or transcript of an image or audio file. */
export interface DerivedText {
  text: string;
  state: DerivedState;
}

/** What a change of the describer settings would touch. */
export interface MediaDescriberInfo {
  /** A model and an agent are set, so files are described. */
  enabled: boolean;
  /** Image and audio files. */
  files: number;
  /** Those with no text. */
  empty: number;
}

/** A folder on the computer that sessions can use (files unification design). */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  writable: boolean;
  createdAt: string;
  updatedAt: string;
  /** In the trash. */
  deleted: boolean;
  /** The parts that are searched; "" is all of the folder. */
  ticks: string[];
}

export interface WorkspaceInput {
  name: string;
  path: string;
  writable: boolean;
}

/** A workspace as a project or session has it. */
export interface WorkspaceAttachment {
  workspace: Workspace;
  /** Whose attachment this is: a session also has its project's. */
  from: "project" | "session";
  readOnly: boolean;
  /** Whether it can be changed in this owner, after every attachment. */
  effectiveWritable: boolean;
}

/** An "Always allow" the user gave a tool for one workspace. */
export interface WorkspaceGrant {
  tool: string;
  workspaceId: string;
  workspaceName: string | null;
}

/** What a tree shows for a path: searched, partly searched or not. */
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

/** The ticks of a workspace and how its index stands. */
export interface WorkspaceIndexView {
  ticks: string[];
  status: WorkspaceIndexStatus | null;
}

/** The folders inside a folder, for the folder picker. */
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
  /** Router mode only, for example "loaded", "loading" or "unloaded". */
  status?: string;
  /** Router mode only: the last load attempt failed. */
  failed?: boolean;
  /**
   * What the model can read: "text" and each media type it supports, such
   * as "image" and "audio". Left out when llama-server does not say.
   */
  inputModalities?: string[];
}

/**
 * Where files live (files and memory design, section 3.3).
 */
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

/** What an upload made (`POST …/files`). */
export interface UploadedFile {
  key: string;
  /** For example `session://cat.png`. */
  ref: string;
  mediaType: MediaType;
  size: number;
  blob: BlobRef;
  /** True when it replaced a file of the same name. */
  replaced: boolean;
}

/** A file. */
export interface StoredFile {
  key: string;
  /** Files only. */
  mediaType?: MediaType;
  /** For a deleted file, its last value. Empty for a binary file. */
  value: string;
  /** Binary files: where the bytes are (`blobUrl`). */
  blob?: BlobRef;
  updatedAt: string;
  deleted: boolean;
}

export interface FileVersion {
  seq: number;
  mediaType?: MediaType;
  /** For a deletion, the value at the time. */
  value: string;
  /** Binary files: the bytes of this version. */
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

export type { ToolGrant, ToolMode };

/** What each version of an agent holds. */
export interface AgentContent {
  name: string;
  description: string;
  prompt: string;
  /**
   * Which tools the agent has: groups, exceptions and extras (tool
   * management design). `known` is set by the backend on every save.
   */
  toolGrant: ToolGrant;
  /**
   * Tool name to true (ask before each call) or false (don't ask). A tool
   * not named follows its own setting.
   */
  toolApproval: Record<string, boolean>;
  /**
   * Reminders this agent gets as a subagent. Null: the global setting
   * applies.
   */
  childReminders: number | null;
  /**
   * The line added to its system message as a subagent. Null: the global
   * setting applies; empty: no line.
   */
  childPrompt: string | null;
  /** Whether `start_subagent` can start this agent. */
  subagent: boolean;
}

/** A tool as the agent editor lists it. */
export interface AgentToolInfo {
  name: string;
  description: string;
  group: ToolGroup;
  /** Offered to every agent: shown locked. */
  alwaysOn: boolean;
  /** Switched off for the whole harness in Settings. */
  off: boolean;
  /** Destructive or prompt-changing: it has to be listed on its own. */
  needsReview: boolean;
}

/** A tool as the agent editor's approval choices list it. */
export interface ToolApprovalInfo {
  name: string;
  description: string;
  group: ToolGroup;
  /** Offered to every agent now, whatever its selection. */
  alwaysOn: boolean;
  /** Whether the tool asks now, by its setting or default. */
  ask: boolean;
  /** True for a tool that always asks: no setting can change it. */
  fixed: boolean;
}

export interface Agent extends AgentContent {
  id: string;
  /**
   * Tools added since the agent was last saved (design, decision 9). Empty
   * for a deny agent and a built-in one.
   */
  newTools: string[];
  /** Null: global. */
  projectId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  /** A built-in agent: read-only, never deleted. */
  builtin: boolean;
}

export interface AgentVersion extends AgentContent {
  seq: number;
  /** A deletion; the content is what the agent had then. */
  deleted: boolean;
  createdAt: string;
}

/** An agent in a list; `isDefault` is set in a project's list. */
export interface ListedAgent extends Agent {
  isDefault: boolean;
}

export interface AgentDetail extends Agent {
  versions: AgentVersion[];
}

/** Where agents live: global, or a project. */
export type AgentScope = { scope: "global" } | { scope: "project"; id: string };

const agentsBase = (s: AgentScope) =>
  s.scope === "global" ? "/api/global/agents" : `/api/projects/${s.id}/agents`;

/** An agent a session can pick, labelled with its scope. */
export interface PickableAgent {
  id: string;
  name: string;
  description: string;
  scope: "project" | "global";
  /** The project's default agent. */
  isDefault: boolean;
  /** A built-in agent. */
  builtin: boolean;
}

/** What each version of a skill holds (skills design). */
export interface SkillContent {
  displayName: string;
  description: string;
  body: string;
}

export type SkillScopeName = "builtin" | "global" | "project" | "agent";

export interface Skill extends SkillContent {
  id: string;
  /** The name the model uses: the slug of the display name. */
  name: string;
  scope: SkillScopeName;
  projectId: string | null;
  agentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface SkillVersion extends SkillContent {
  seq: number;
  /** The slug in that version. */
  name: string;
  /** A deletion; the content is what the skill had then. */
  deleted: boolean;
  createdAt: string;
}

export interface SkillDetail extends Skill {
  versions: SkillVersion[];
}

/** Where skills live: global, in a project, or in an agent. */
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

// ---- Schemas and data (schemas and data design) ---------------------------

/** Where data lives (decision 3). */
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

/** A piece of data as a list shows it. */
export type DataItem = DataInfo;

/** One saved state of a piece of data (decision 24). */
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

/** A piece of data with its value, schema and history. */
export interface DataDetail extends DataView {
  /** Null when its schema is not in scope here (plan P9). */
  schema:
    | (SchemaInfo & {
        /** The JSON Schema of the version the data is on. */
        pinned: unknown;
        /** The JSON Schema of the latest version. */
        latest: unknown;
      })
    | null;
  versions: DataVersion[];
}

/** Where a schema copy goes (decision 12). */
export type CopyTarget =
  | { scope: "global" }
  | { scope: "project"; id: string }
  | { scope: "agent"; id: string };

const schemasBase = (o: DataOwner) =>
  dataBase(o).replace(/\/data$/, "/schemas");

/** A schema with every version's JSON Schema. */
export interface SchemaDetail extends SchemaInfo {
  /** The latest version's JSON Schema. */
  body: unknown;
  versions: { version: number; body: unknown }[];
  /** How much data is made from it here and in scopes this owner sees. */
  dataCount: number;
}

/** What the schema editor saves. */
export interface SchemaContent {
  name: string;
  description: string;
  body: unknown;
}

/** What a data form saves. */
export interface DataContent {
  name: string;
  description: string;
  value: unknown;
}

/** A 409 from an import whose name is taken. */
export interface ImportConflict {
  agentId: string;
  deleted: boolean;
}

/** A recorded error (error reporting plan, P5). */
export interface ErrorEntry {
  id: string;
  sessionId: string;
  sessionTitle: string;
  /** Null: a standalone session. */
  projectId: string | null;
  projectName: string | null;
  runId: string | null;
  /** The tool result message, for the link to the transcript. */
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

/** Narrows the errors list. `projectId: "none"`: standalone sessions. */
export interface ErrorFilter {
  sessionId?: string;
  projectId?: string;
  source?: "tool" | "run";
  tool?: string;
}

/** The values the global console's filters can take. */
export interface ErrorFilterOptions {
  sessions: { id: string; title: string; projectId: string | null }[];
  projects: { id: string; name: string }[];
  tools: string[];
  /** Whether there are failed runs. */
  runs: boolean;
}

/** How an MCP server's connection stands (MCP design). */
export type McpState = "disabled" | "connecting" | "connected" | "failed";

export interface McpToolInfo {
  /** The name agents and settings use. */
  name: string;
  /** The server's own name for it. */
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

/** What the user enters for an MCP server. */
export interface McpServerInput {
  name: string;
  enabled: boolean;
  config: McpConfig;
}

export interface McpServerView extends McpServerInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: {
    state: McpState;
    /** Set when `state` is "failed". */
    error: string | null;
    /** The tools of a connected server. */
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
  /** One session's errors, or every error the global console shows. */
  clearErrors: (sessionId?: string) =>
    request<{ cleared: number }>(
      "DELETE",
      `/api/errors${
        sessionId ? `?${new URLSearchParams({ sessionId }).toString()}` : ""
      }`,
    ),
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
  /** One page of a project's sessions, or of the standalone ones. */
  listSessionsPage: (q: SessionPageQuery) => {
    const params = new URLSearchParams({
      direction: q.direction,
      page: String(q.page),
      pageSize: String(q.pageSize),
    });
    if (q.projectId) params.set("projectId", q.projectId);
    return request<SessionPage>("GET", `/api/sessions-page?${params}`);
  },
  /** The ids of every session with a reply the user has not seen, in any project. */
  listUnreadSessions: () =>
    request<{ sessions: UnreadSession[] }>("GET", "/api/sessions-unread/list"),
  /** Every session of a project (or the standalone ones), and whether it is running. */
  listSessionIds: (projectId: string | null) =>
    request<{ sessions: { id: string; running: boolean }[] }>(
      "GET",
      `/api/sessions-page/ids${
        projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      }`,
    ),
  /** Every run in progress in any session, subagents' included. */
  listActiveRuns: () =>
    request<{ runs: ActiveRun[] }>("GET", "/api/runs/active"),
  /** Moves several sessions to the trash; the ones that cannot move are listed. */
  trashSessions: (ids: readonly string[]) =>
    request<TrashSessionsResult>("POST", "/api/sessions/trash", { ids }),
  /** Creates a session, in a project when one is given. */
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
    request<{
      purged: { projects: number; sessions: number; branches: number };
    }>("DELETE", "/api/trash"),
  /** Brings a deleted branch back. */
  restoreBranch: (messageId: string) =>
    request<{ ok: true }>("POST", `/api/trash/branches/${messageId}/restore`),
  /** Permanently deletes a deleted branch, with everything under it. */
  deleteTrashedBranch: (messageId: string) =>
    request<{ ok: true }>("DELETE", `/api/trash/branches/${messageId}`),
  listProjects: () => request<Project[]>("GET", "/api/projects"),
  getProject: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  createProject: (p: { name: string; description: string }) =>
    request<Project>("POST", "/api/projects", p),
  /** A field left out is unchanged. */
  updateProject: (
    id: string,
    fields: {
      name?: string;
      description?: string;
      /** An agent id, or null for none. */
      defaultAgentId?: string | null;
      systemPrompt?: string;
    },
  ) => request<Project>("PATCH", `/api/projects/${id}`, fields),
  trashProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/trash`),
  restoreProject: (id: string) =>
    request<Project>("POST", `/api/projects/${id}/restore`),
  /** Permanently deletes a project in the trash, with its sessions. */
  deleteProject: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/projects/${id}`),
  sendMessage: (
    id: string,
    content: string,
    choices: Choices,
    /** References to image or audio files, such as `session://cat.png`. */
    files: readonly string[] = [],
  ) =>
    request<{ runId: string }>("POST", `/api/sessions/${id}/messages`, {
      content,
      ...(files.length > 0 ? { files } : {}),
      ...choices,
    }),
  /**
   * Edits the text of one of the user's messages. `mode` left out is the
   * Settings default; "branch" keeps the old message on a branch and answers
   * the copy, "in_place" overwrites the text.
   */
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
  /** Asks for another reply to the last turn; the old one stays as a branch. */
  regenerate: (id: string, choices: Choices) =>
    request<{ runId: string }>(
      "POST",
      `/api/sessions/${id}/regenerate`,
      choices,
    ),
  /**
   * Ends the line at a message, which is kept. At a user message the model
   * answers right away (`runId` set).
   */
  branchOff: (id: string, messageId: string, choices: Choices) =>
    request<{ runId: string | null }>("POST", `/api/sessions/${id}/branch`, {
      messageId,
      ...choices,
    }),
  /** Copies the line up to a message into a new session. */
  forkSession: (id: string, messageId: string, title: string) =>
    request<Session>("POST", `/api/sessions/${id}/fork`, { messageId, title }),
  /** Shows another branch. */
  switchBranch: (id: string, messageId: string) =>
    request<{ tipId: string }>("POST", `/api/sessions/${id}/switch`, {
      messageId,
    }),
  /** Deletes a branch to the Trash. */
  deleteBranch: (id: string, messageId: string) =>
    request<{ tipId: string }>(
      "DELETE",
      `/api/sessions/${id}/branches/${messageId}`,
    ),
  /**
   * Uploads an image or audio file to a scope as a binary file. A name in
   * use gets a suffix unless `replace` is set; the result names the file
   * that was made.
   */
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
  /**
   * A binary file's bytes as an object URL. The request carries the token,
   * which an <img> or <audio> element cannot send, so the file is fetched
   * here and shown from the URL.
   */
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
  /** Checks a selection of an open request's changes (decision 33). */
  checkApproval: (runId: string, requestId: string, selection: Selection) =>
    request<{ errors: string[]; stale: boolean }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}/check`,
      { selection },
    ),
  /** Works an open request's changes out again (decision 30). */
  refreshApproval: (runId: string, requestId: string) =>
    request<{ request: ApprovalRequest }>(
      "POST",
      `/api/runs/${runId}/approvals/${encodeURIComponent(requestId)}/refresh`,
    ).then((r) => r.request),
  /** Answers a form: its answers, or skipped. */
  answerInput: (runId: string, requestId: string, answer: InputAnswer) =>
    request<{ ok: true }>(
      "POST",
      `/api/runs/${runId}/inputs/${encodeURIComponent(requestId)}`,
      answer,
    ),
  /** Sends a message to a running subagent; it reads it at its next step. */
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
  /** A workspace image or audio file's bytes, as an object URL. */
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
  /** Connects again; answers when the attempt is over. */
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
  /** Applies settings to every tool of a group; returns the group's tools. */
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
  /** Creates or replaces a file. */
  writeFile: (s: FileScope, key: string, mediaType: MediaType, value: string) =>
    request<FileDetail>("PUT", `${filesBase(s)}/${encodeURIComponent(key)}`, {
      mediaType,
      value,
    }),
  /** Every folder of a scope, explicit or holding files. */
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
  /** Makes an earlier version current; also restores a deleted file. */
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
  /** Every tool, with its group and whether it is always on (shown locked). */
  agentTools: () => request<AgentToolInfo[]>("GET", "/api/agent-tools"),
  agentToolApprovals: () =>
    request<ToolApprovalInfo[]>("GET", "/api/agent-tool-approvals"),
  listSkills: (o: SkillOwner, deleted: boolean) =>
    request<Skill[]>(
      "GET",
      `${skillsBase(o)}${deleted ? "?deleted=true" : ""}`,
    ),
  getSkill: (id: string) => request<SkillDetail>("GET", `/api/skills/${id}`),
  createSkill: (o: SkillOwner, c: SkillContent) =>
    request<SkillDetail>("POST", skillsBase(o), c),
  /** Saves a new version. */
  saveSkill: (id: string, c: SkillContent) =>
    request<SkillDetail>("PUT", `/api/skills/${id}`, c),
  deleteSkill: (id: string) => request<unknown>("DELETE", `/api/skills/${id}`),
  /** Makes an earlier version current; also restores a deleted skill. */
  restoreSkill: (id: string, seq: number) =>
    request<SkillDetail>("POST", `/api/skills/${id}/restore`, { seq }),
  listData: (o: DataOwner, deleted: boolean) =>
    request<{ readOnly: string | null; data: DataItem[] }>(
      "GET",
      `${dataBase(o)}${deleted ? "?deleted=true" : ""}`,
    ),
  /** The schemas whose data can be made for this owner. */
  dataSchemas: (o: DataOwner) =>
    request<SchemaInfo[]>("GET", `${dataBase(o)}/schemas`),
  /** A schema in scope for this owner, with its latest JSON Schema. */
  schemaBody: (o: DataOwner, schemaId: string) =>
    request<SchemaInfo & { body: unknown }>(
      "GET",
      `${dataBase(o)}/schemas/${encodeURIComponent(schemaId)}`,
    ).then((r) => r.body),
  /** A piece of data with its schema versions and history. */
  getData: (o: DataOwner, id: string) =>
    request<DataDetail>("GET", `${dataBase(o)}/${encodeURIComponent(id)}`),
  createData: (o: DataOwner, schemaId: string, c: DataContent) =>
    request<DataView>("POST", dataBase(o), { schemaId, ...c }),
  saveData: (o: DataOwner, id: string, c: DataContent) =>
    request<DataView>("PUT", `${dataBase(o)}/${encodeURIComponent(id)}`, c),
  /** Moves the data to its schema's latest version with this value. */
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
  /** A new version when the JSON Schema changed (decision 10). */
  saveSchema: (o: DataOwner, id: string, c: SchemaContent) =>
    request<SchemaInfo>(
      "PUT",
      `${schemasBase(o)}/${encodeURIComponent(id)}`,
      c,
    ),
  /** Deletes it with its data (decision 14); says how much data. */
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
  /** The session's composed prompts, transcript and every event. */
  getSessionDebug: (id: string) =>
    request<SessionDebug>("GET", `/api/sessions/${id}/debug`),
  getDerivedText: (hash: string) =>
    request<DerivedText>("GET", `/api/blobs/${hash}/derived-text`),
  /** Empty text clears it. */
  setDerivedText: (hash: string, text: string) =>
    request<DerivedText>("PUT", `/api/blobs/${hash}/derived-text`, { text }),
  /** Writes the text again with the Media Describer. */
  describeFile: (hash: string) =>
    request<DerivedText>("POST", `/api/blobs/${hash}/describe`),
  getMediaDescriber: () =>
    request<MediaDescriberInfo>("GET", "/api/media-describer"),
  /** The answer to "Generate descriptions for N files?". */
  regenerateDescriptions: (mode: "empty" | "all") =>
    request<{ queued: number }>("POST", "/api/media-describer/regenerate", {
      mode,
    }),
  /** The user's keep or drop choices for the session's images and audio. */
  getMediaChoices: (id: string) =>
    request<{ ref: string; keep: boolean }[]>(
      "GET",
      `/api/sessions/${id}/media-choices`,
    ),
  /** `keep: null` clears the choice, so the defaults decide again. */
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

/** The app-wide event stream (agents.changed, skills.changed, errors.changed). */
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
