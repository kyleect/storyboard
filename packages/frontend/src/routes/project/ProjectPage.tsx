import { Alert, Button, Group, Loader, Stack, Textarea } from "@mantine/core";
import { useCreateSession } from "../../hooks/useSessions";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { DefaultAgentSelect } from "../agents/Agents";
import { EditableTitle } from "./components/EditableTitle";
import { ProjectColorPicker } from "../../components/ProjectColorPicker";
import { SessionsPage } from "../sessions/Sessions";
import { AttachedWorkspaces } from "../workspaces/Workspaces";
import { showError } from "../../lib/notify";
import { useProjectActions } from "../../hooks/useProjectActions";
import { useProject, useSaveProject } from "../../hooks/useProjects";

export function ProjectPage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const actions = useProjectActions();
  const project = useProject(projectId);
  const save = useSaveProject(projectId);

  const create = useCreateSession((session) =>
    navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } }),
  );

  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;

  return (
    <Stack gap="lg">
      <Stack maw={720} gap="md">
        <EditableTitle
          title={project.data.name}
          label="Project name"
          disabled={trashed}
          onSave={(name) => save({ name })}
        />
        {trashed && (
          <Alert color="yellow" title="This project is in the trash">
            Restore it from the Trash tab in Settings to change it.
          </Alert>
        )}
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/projects/$projectId/files"
                params={{ projectId }}
              />
            )}
          >
            Files
          </Button>
          <Button
            size="xs"
            variant="default"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/projects/$projectId/agents"
                params={{ projectId }}
              />
            )}
          >
            Agents
          </Button>
          <Button
            size="xs"
            variant="default"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/projects/$projectId/skills"
                params={{ projectId }}
              />
            )}
          >
            Skills
          </Button>
          <Button
            size="xs"
            variant="default"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/projects/$projectId/data"
                params={{ projectId }}
              />
            )}
          >
            Structured Data
          </Button>
        </Group>
        <ProjectColorPicker
          value={project.data.color}
          disabled={trashed}
          onChange={(color) =>
            save({ color }).catch(showError("Could not save the color"))
          }
        />
        <DefaultAgentSelect project={project.data} disabled={trashed} />
        <SavedText
          key={`d:${project.data.description}`}
          label="Description"
          what="description"
          initial={project.data.description}
          disabled={trashed}
          onSave={(description) => save({ description })}
        />
        <SavedText
          key={`p:${project.data.system_prompt}`}
          label="System prompt"
          help="Sent in every chat in this project, after the global system prompt and before the agent's. Leave it empty to send none. Write {{skills}}, {{tools}}, {{schemas}}, {{data}}, {{agents}} or {{workspaces}} to put the list of skills, tools, schemas, data, agents (the ones it can start) or workspaces the chat has at that place. Write {{date}} or {{time}} for the date or the time of day when the run starts. Wrap text in {{#skills}}…{{/skills}} (or any other of these names) to keep it only when the chat has some, and in {{^skills}}…{{/skills}} to keep it only when it has none. Write {{files}} to list the files the chat can see. Write {{skills_instruction}}, {{tools_instruction}}, {{schemas_instruction}}, {{data_instruction}}, {{agents_instruction}}, {{workspaces_instruction}} or {{files_instruction}} for the wording that introduces a list, apart from the list."
          what="system prompt"
          initial={project.data.system_prompt}
          disabled={trashed}
          onSave={(systemPrompt) => save({ systemPrompt })}
        />

        <AttachedWorkspaces
          owner="projects"
          id={projectId}
          disabled={trashed}
        />
      </Stack>

      <Stack gap="sm">
        <Group justify="flex-end">
          {!trashed && (
            <Group gap="xs">
              <Button
                size="xs"
                onClick={() => create.mutate(projectId)}
                loading={create.isPending}
              >
                New chat
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                onClick={() => actions.confirmTrash(project.data)}
              >
                Move project to trash
              </Button>
            </Group>
          )}
        </Group>
        <SessionsPage projectId={projectId} />
      </Stack>
    </Stack>
  );
}

function SavedText({
  label,
  help,
  what,
  initial,
  disabled,
  onSave,
}: {
  label: string;
  help?: string;
  what: string;
  initial: string;
  disabled: boolean;
  onSave: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);

  return (
    <Stack gap="xs">
      <Textarea
        label={label}
        description={help}
        autosize
        minRows={2}
        maxRows={12}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.currentTarget.value)}
      />
      {!disabled && (
        <Button
          size="xs"
          variant="light"
          w="fit-content"
          disabled={draft === initial}
          loading={saving}
          onClick={() => {
            setSaving(true);
            onSave(draft)
              .catch(showError(`Could not save the ${what}`))
              .finally(() => setSaving(false));
          }}
        >
          Save {what}
        </Button>
      )}
    </Stack>
  );
}
