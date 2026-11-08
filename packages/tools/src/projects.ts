import { z } from "zod";
import {
  defineTool,
  type Form,
  type FormField,
  type ProjectPush,
} from "@harness/core";
import {
  copyableAgent,
  copyData,
  dataLabel,
  planDataCopy,
  withDelegationNote,
} from "./project-copy.js";
import { fail, guarded, notDone } from "./results.js";

/*
 * Project tools (agent tools design, 3.3 and 3.5). `projects_list` runs
 * without asking; `project_view` and `project_create` always ask (they
 * cannot be switched off).
 */

export const projectsList = defineTool({
  name: "projects_list",
  description:
    "Lists projects (not those in the trash) with their id, name and description. Use an id as the destination of files_copy, memory_copy, files_move or memory_move.",
  input: z.object({}),
  approval: "never",
  group: "projects",
  execute: (_input, ctx) => ({ data: { projects: ctx.projects.list() } }),
});

export const projectView = defineTool({
  name: "project_view",
  description:
    "Shows this session's project: its name, description, default agent and system prompt. Says so when the session is not in a project. The user must approve each call.",
  input: z.object({}),
  approval: "always",
  group: "projects",
  execute: (_input, ctx) => {
    const project = ctx.projects.current();
    return {
      data: project
        ? {
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              defaultAgent: project.defaultAgent,
              systemPrompt: project.systemPrompt,
            },
          }
        : { project: null, note: "This session is not in a project." },
    };
  },
});

/** Where a field's checkbox says how many entries it covers. */
const countText = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

export const projectCreate = defineTool({
  name: "project_create",
  description:
    "Creates a new project from this session. Suggest a name, description and system prompt, leaving out what you don't know; the user edits them in a form and chooses what is copied into the new project: this session's files, memory notes, schemas and data, and the agent this session is using (offered unless it is the built-in Dispatcher or there is none). A copied agent can be started as a subagent, and a note is added to the end of the project's system prompt telling the Dispatcher to hand the project's work to it, so do not write that yourself. The project can then be opened and used at once. The session itself is not changed. The user must approve each call.",
  input: z.object({
    name: z.string().optional().describe("A name to suggest."),
    description: z.string().optional().describe("A description to suggest."),
    systemPrompt: z
      .string()
      .optional()
      .describe(
        "A system prompt to suggest for the project. Sent to every session in it.",
      ),
  }),
  approval: "always",
  group: "projects",
  execute: ({ name, description, systemPrompt }, ctx) =>
    guarded({}, async () => {
      const files = ctx.entries.listFiles("session");
      const notes = ctx.entries.listNotes("session");
      const plan = planDataCopy(ctx);
      const hasData = plan.schemas.length > 0 || plan.data.length > 0;
      const agent = copyableAgent(ctx);
      const tick = (
        field: string,
        label: string,
        help?: string,
      ): FormField => ({
        name: field,
        label,
        ...(help ? { help } : {}),
        required: false,
        noOther: true,
        kind: "boolean",
        default: true,
      });
      const fields: FormField[] = [
        {
          name: "name",
          label: "Name",
          required: true,
          kind: "text",
          multiline: false,
          ...(name ? { default: name } : {}),
        },
        {
          name: "description",
          label: "Description",
          required: false,
          kind: "text",
          multiline: true,
          ...(description ? { default: description } : {}),
        },
        {
          name: "systemPrompt",
          label: "System prompt",
          help: agent
            ? "Sent to every session in the project, after the global prompt. If the agent is copied, a note is added at the end telling the Dispatcher to hand work to it."
            : "Sent to every session in the project, after the global prompt.",
          required: false,
          kind: "text",
          multiline: true,
          ...(systemPrompt ? { default: systemPrompt } : {}),
        },
        ...(files.length > 0
          ? [
              tick(
                "copyFiles",
                `Copy this session's files (${countText(files.length, "file")})`,
              ),
            ]
          : []),
        ...(notes.length > 0
          ? [
              tick(
                "copyNotes",
                `Copy this session's memory notes (${countText(notes.length, "note")})`,
              ),
            ]
          : []),
        ...(hasData
          ? [
              tick(
                "copyData",
                `Copy this session's structured data (${dataLabel(plan)})`,
                "Schemas keep their versions. Data made from a global or built-in schema keeps using it.",
              ),
            ]
          : []),
        ...(agent
          ? [
              tick(
                "copyAgent",
                `Copy the agent this session is using ("${agent.name}")`,
                "The copy becomes a project agent that can be started as a subagent, with the agent's own skills, schemas and data. New sessions in the project start with the Dispatcher, which hands the work to it.",
              ),
            ]
          : []),
      ];
      const form: Form = {
        title: "Create a project from this session",
        description: agent
          ? "This session stays where it is."
          : "The project has no agent. This session stays where it is.",
        fields,
        submitLabel: "Create",
        skipLabel: "Don't create",
      };
      const answer = await ctx.requestInput(form);
      if (answer.outcome === "skipped")
        return notDone("Not created: the user chose not to create a project.");
      const a = answer.answers;
      const projectName = String(a["name"]).trim();
      if (projectName === "")
        return fail("The project needs a name.", "rejected");
      const prompt = String(a["systemPrompt"] ?? "").trim();
      const project = ctx.projects.create({
        name: projectName,
        description: String(a["description"] ?? "").trim(),
        systemPrompt: prompt,
      });

      const wantFiles = a["copyFiles"] === true;
      const wantNotes = a["copyNotes"] === true;
      const wantData = hasData && a["copyData"] === true;
      const wantAgent = agent !== null && a["copyAgent"] === true;
      let filesCopied = 0;
      let notesCopied = 0;
      let schemasCopied = 0;
      let dataCopied = 0;
      let copiedAgent: ReturnType<ProjectPush["putAgent"]> | undefined;
      let dispatcherSet = false;
      try {
        const push = ctx.projects.push(project.id);
        // The agent first: it is what makes the project usable at once. The
        // note and the Dispatcher come only once the copy exists, so the
        // prompt never names an agent that is not there.
        if (wantAgent) {
          copiedAgent = push.putAgent();
          push.setSystemPrompt(withDelegationNote(prompt, copiedAgent));
          dispatcherSet = push.useDispatcher();
        }
        if (wantFiles) {
          for (const info of files) {
            const file = ctx.entries.readFile("session", info.key);
            if (!file) continue;
            push.putFile(file.key, file.mediaType, file.value, file.blob);
            filesCopied++;
          }
        }
        if (wantNotes) {
          for (const note of notes) {
            push.addNote(note.text);
            notesCopied++;
          }
        }
        if (wantData) {
          copyData(
            push,
            plan,
            () => schemasCopied++,
            () => dataCopied++,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const done = [
          ...(wantAgent ? [copiedAgent ? "the agent" : "no agent"] : []),
          countText(filesCopied, "file"),
          countText(notesCopied, "note"),
          ...(wantData
            ? [
                countText(schemasCopied, "schema"),
                `${dataCopied} piece${dataCopied === 1 ? "" : "s"} of data`,
              ]
            : []),
        ];
        return fail(
          `The project "${project.name}" (id ${project.id}) was created, but copying stopped after ${done.join(", ")}: ${message}`,
          "rejected",
          { projectId: project.id },
        );
      }
      return {
        data: {
          project: { id: project.id, name: project.name },
          filesCopied,
          notesCopied,
          ...(wantData
            ? {
                schemasCopied,
                dataCopied,
                ...(plan.skipped.length > 0
                  ? { dataSkipped: plan.skipped }
                  : {}),
              }
            : {}),
          ...(copiedAgent
            ? {
                agent: copiedAgent,
                note: `The agent was copied into the project, with its own skills, schemas and data, and can be started as a subagent. A note was added to the project's system prompt telling the Dispatcher to hand the project's work to it${dispatcherSet ? ", and new sessions in the project start with the Dispatcher" : ""}.`,
              }
            : {}),
        },
      };
    }),
});

export const projectTools = [projectsList, projectView, projectCreate];
