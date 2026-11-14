import {
  type Form,
  type InputAnswer,
  type InputRequest,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import { type MessageAgent, type StoredMessage } from "../../../api";

export interface Asks {
  results: ReadonlyMap<string, ToolResultMessage>;
  opens: readonly OpenForm[];
  submitted: ReadonlyMap<string, Sent>;
  busy: boolean;
  onAnswer: (open: OpenForm, answer: InputAnswer) => void;
  subagents: ReadonlyMap<string, SubagentView>;
  onSendToSubagent: (runId: string, text: string) => void;
  sendingToSubagent: boolean;
  reveal?: string | null;
}
export interface OpenForm {
  request: InputRequest;
  runId: string;
}
export interface SubagentView {
  agentName: string;
  messages: ShownMessage[];
  running: boolean;
  runId: string | null;
  queued: readonly string[];
  waiting: boolean;
}
export interface Sent {
  form: Form;
  answers: Record<string, unknown>;
}
export interface ShownMessage {
  id: string;
  message: Message;
  model: string | null;
  reasoningEffort: string | null;
  agent: MessageAgent | null;
  streaming: boolean;
  usage?: Usage | undefined;
  branches?: StoredMessage["branches"] | undefined;
}
