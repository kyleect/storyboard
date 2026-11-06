import { z } from "zod";
import { defineTool, type Form, type FormField } from "@harness/core";
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
    "Creates a new project from this session. Suggest a name, description and system prompt, leaving out what you don't know; the user edits them in a form and chooses whether this session's files and memory notes are copied into the new project. The project has no agent and the session itself is not changed. The user must approve each call.",
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
          help: "Sent to every session in the project, after the global prompt.",
          required: false,
          kind: "text",
          multiline: true,
          ...(systemPrompt ? { default: systemPrompt } : {}),
        },
        ...(files.length > 0
          ? [
              {
                name: "copyFiles",
                label: `Copy this session's files (${countText(files.length, "file")})`,
                required: false,
                noOther: true,
                kind: "boolean" as const,
                default: true,
              },
            ]
          : []),
        ...(notes.length > 0
          ? [
              {
                name: "copyNotes",
                label: `Copy this session's memory notes (${countText(notes.length, "note")})`,
                required: false,
                noOther: true,
                kind: "boolean" as const,
                default: true,
              },
            ]
          : []),
      ];
      const form: Form = {
        title: "Create a project from this session",
        description:
          "The project has no agent. This session stays where it is.",
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
      const project = ctx.projects.create({
        name: projectName,
        description: String(a["description"] ?? "").trim(),
        systemPrompt: String(a["systemPrompt"] ?? "").trim(),
      });
      let filesCopied = 0;
      let notesCopied = 0;
      try {
        const push = ctx.projects.push(project.id);
        if (a["copyFiles"] === true) {
          for (const info of files) {
            const file = ctx.entries.readFile("session", info.key);
            if (!file) continue;
            push.putFile(file.key, file.type, file.value);
            filesCopied++;
          }
        }
        if (a["copyNotes"] === true) {
          for (const note of notes) {
            push.addNote(note.text);
            notesCopied++;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(
          `The project "${project.name}" (id ${project.id}) was created, but copying stopped after ${countText(filesCopied, "file")} and ${countText(notesCopied, "note")}: ${message}`,
          "rejected",
          { projectId: project.id },
        );
      }
      return {
        data: {
          project: { id: project.id, name: project.name },
          filesCopied,
          notesCopied,
        },
      };
    }),
});

export const projectTools = [projectsList, projectView, projectCreate];
