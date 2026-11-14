import {
  type Form,
  type InputAnswer,
  type InputRequest,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@harness/core";
import { type MessageAgent, type StoredMessage } from "../../../api";

/**
 * What tool calls need to draw their forms: `ask_user`'s (input forms
 * design) and other tools' (tool prompts design).
 */
export interface Asks {
  /** Tool results by call id. */
  results: ReadonlyMap<string, ToolResultMessage>;
  /** The forms waiting for an answer, in any of the session's runs. */
  opens: readonly OpenForm[];
  /** Forms answered, by call id, shown until the result is stored. */
  submitted: ReadonlyMap<string, Sent>;
  busy: boolean;
  onAnswer: (open: OpenForm, answer: InputAnswer) => void;
  /**
   * The work of the subagent each `start_subagent` call started, by call id
   * (agent delegation design, decision 42).
   */
  subagents: ReadonlyMap<string, SubagentView>;
  /** Sends a message to a running subagent (by its run id). */
  onSendToSubagent: (runId: string, text: string) => void;
  /** A message to a subagent is being sent. */
  sendingToSubagent: boolean;
  /** The anchor of a message to scroll to, so its subagent opens. */
  reveal?: string | null;
}
/** A form waiting for an answer, with the run that must receive it. */
export interface OpenForm {
  request: InputRequest;
  runId: string;
}
/** A subagent's run under the call that started it. */
export interface SubagentView {
  agentName: string;
  /** Its messages, the task first, with the one being written now. */
  messages: ShownMessage[];
  running: boolean;
  /** Its run id while it runs; the user can send it messages. */
  runId: string | null;
  /** Messages the user sent that it has not read yet, oldest first. */
  queued: readonly string[];
  /** It is waiting for the user: a form or an approval is open. */
  waiting: boolean;
}
/** A form the user answered, and the answers sent. */
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
  /** Running token count while streaming. */
  usage?: Usage | undefined;
  /** The messages that can start here, with this one's place among them. */
  branches?: StoredMessage["branches"] | undefined;
}
