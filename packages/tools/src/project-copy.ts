import {
  MAX_DATA_NAME,
  type CurrentAgent,
  type ProjectPush,
  type ToolContext,
} from "@harness/core";

/*
 * What `project_create` copies besides files: the session's schemas
 * and data, and the agent the session is using, plus the note that tells the
 * Dispatcher to hand work to that agent.
 */

/** A schema to create in the new project, with every version it has. */
export interface SchemaCopy {
  /** The id it has now: its session id, or its id in the project or agent scope. */
  fromId: string;
  name: string;
  description: string;
  versions: unknown[];
}

/** A piece of data to create in the new project. */
export interface DataCopy {
  name: string;
  description: string;
  value: unknown;
  schemaVersion: number;
  /** Where its schema comes from: one made in the project, or one kept as it is. */
  schema: { copy: string } | { keep: string };
}

/** What copying the session's structured data would do. */
export interface DataPlan {
  schemas: SchemaCopy[];
  data: DataCopy[];
  /** Data left out, with why, for the model. */
  skipped: { name: string; because: string }[];
}

export const EMPTY_PLAN: DataPlan = { schemas: [], data: [], skipped: [] };

/**
 * Works out what copying the session's schemas and data takes: every live
 * session schema, and every piece of session data. Data made from a global or
 * built-in schema keeps pointing at it. Data made from a schema that only the
 * session, this project or the run's agent can see needs that schema in the
 * new project, so the schema is copied too (once, with its versions). A
 * schema name already taken by another copy gets " (2)", " (3)" and so on.
 */
export function planDataCopy(ctx: ToolContext): DataPlan {
  if (!ctx.data.scopes.includes("session")) return EMPTY_PLAN;

  const schemas = new Map<string, SchemaCopy>();
  const taken = new Set<string>();
  const addSchema = (id: string): boolean => {
    if (schemas.has(id)) return true;
    let info;
    let versions;
    try {
      info = ctx.data.getSchema(id);
      versions = ctx.data.schemaVersions(id).map((v) => v.body);
    } catch {
      return false;
    }
    schemas.set(id, {
      fromId: id,
      name: freeName(info.name, taken),
      description: info.description,
      versions,
    });
    return true;
  };

  // Every live session schema, with or without data.
  for (const s of ctx.data.listSchemas("session")) addSchema(s.id);

  const data: DataCopy[] = [];
  const skipped: DataPlan["skipped"] = [];
  for (const info of ctx.data.listData({ scope: "session" })) {
    if (!info.schemaInScope) {
      skipped.push({
        name: info.name,
        because: "its schema is not available here",
      });
      continue;
    }
    let view;
    let scope;
    try {
      view = ctx.data.getData(info.id);
      scope = ctx.data.getSchema(info.schemaId).scope;
    } catch {
      skipped.push({ name: info.name, because: "it could not be read" });
      continue;
    }
    const keeps = scope === "global" || scope === "builtin";
    if (!keeps && !addSchema(info.schemaId)) {
      skipped.push({
        name: info.name,
        because: "its schema could not be copied",
      });
      continue;
    }
    data.push({
      name: view.name,
      description: view.description,
      value: view.value,
      schemaVersion: view.schemaVersion,
      schema: keeps ? { keep: info.schemaId } : { copy: info.schemaId },
    });
  }
  return { schemas: [...schemas.values()], data, skipped };
}

/** `name`, or `name (2)`, `name (3)` ... when taken; at most MAX_DATA_NAME long. */
function freeName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = ` (${n})`;
    candidate = name.slice(0, MAX_DATA_NAME - suffix.length) + suffix;
  }
  taken.add(candidate);
  return candidate;
}

/** Creates the planned schemas, then the data, in the new project. */
export function copyData(
  push: ProjectPush,
  plan: DataPlan,
  onSchema: () => void,
  onData: () => void,
): void {
  const ids = new Map<string, string>();
  for (const s of plan.schemas) {
    ids.set(
      s.fromId,
      push.putSchema({
        name: s.name,
        description: s.description,
        copiedFrom: null,
        versions: s.versions,
      }),
    );
    onSchema();
  }
  for (const d of plan.data) {
    const schemaId =
      "keep" in d.schema ? d.schema.keep : ids.get(d.schema.copy);
    if (schemaId === undefined) continue;
    push.putData({
      schemaId,
      schemaVersion: d.schemaVersion,
      name: d.name,
      description: d.description,
      value: d.value,
    });
    onData();
  }
}

/** "2 schemas and 5 pieces of data", for a form's label. */
export function dataLabel(plan: DataPlan): string {
  const s = plan.schemas.length;
  const d = plan.data.length;
  const schemas = `${s} schema${s === 1 ? "" : "s"}`;
  const pieces = `${d} piece${d === 1 ? "" : "s"} of data`;
  return d === 0 ? schemas : s === 0 ? pieces : `${schemas} and ${pieces}`;
}

/**
 * Whether the run's agent can be copied: there is one, and it is not a
 * built-in one (a built-in agent is available everywhere already).
 */
export function copyableAgent(ctx: ToolContext): CurrentAgent | null {
  const agent = ctx.agents.current();
  return agent && !agent.builtin ? agent : null;
}

/** Marks where the note starts, so the user can find it in the prompt. */
export const DELEGATION_HEADING = "## Who does the work in this project";

/**
 * The note added to the end of the project's system prompt when the agent is
 * copied. Every run in the project reads the project prompt, the agent's own
 * run included, so it speaks to agents that hand work on and tells the rest
 * to ignore it. It names the agent and its scope instead of an id, which the
 * Dispatcher can match in `agents_list`.
 */
export function delegationNote(agent: { name: string }): string {
  return [
    DELEGATION_HEADING,
    "",
    `The work in this project is done by the project agent "${agent.name}" (scope: project in agents_list). It can be started as a subagent.`,
    "",
    `This section is for agents that hand work to other agents, such as the Dispatcher. Do not do the work yourself, and do not pick a global agent, unless the user asks for something "${agent.name}" cannot do. For each request, call agents_list, pick the project agent "${agent.name}" and start it with start_subagent. Put everything it needs in the task: what the user wants, earlier decisions that matter, and the keys of the files it should read or write. If you are "${agent.name}", or you do not hand work on, ignore this section.`,
  ].join("\n");
}

/** The prompt the user wrote, then the note, with a blank line between. */
export function withDelegationNote(
  prompt: string,
  agent: { name: string },
): string {
  const note = delegationNote(agent);
  return prompt.trim() === "" ? note : `${prompt.trim()}\n\n${note}`;
}
