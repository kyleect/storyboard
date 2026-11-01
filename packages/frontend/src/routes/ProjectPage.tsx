import {
  Alert,
  Button,
  Group,
  Loader,
  NavLink,
  Stack,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Project } from "../api";
import { EditableTitle } from "./EditableTitle";
import { SessionMenu, showError, useProjectActions } from "./SessionActions";

/**
 * A project's page (sessions and projects design, Q13b): its name and
 * description, editable here; its sessions; New session; Move to trash.
 */
export function ProjectPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const actions = useProjectActions();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
  });
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.listSessions(projectId),
  });

  const save = async (fields: { name?: string; description?: string }) => {
    const updated = await api.updateProject(projectId, fields);
    queryClient.setQueryData<Project>(["project", projectId], updated);
    // Editing counts as using the project; the picker shows the name.
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const create = useMutation({
    mutationFn: () => api.createSession(projectId),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: session.id },
      });
    },
    onError: showError("Could not create a session"),
  });

  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;

  return (
    <Stack maw={720} gap="md">
      <EditableTitle
        title={project.data.name}
        label="Project name"
        disabled={trashed}
        onSave={(name) => save({ name })}
      />
      {trashed && (
        <Alert color="yellow" title="This project is in the trash">
          Restore it from the Trash section in Settings to change it.
        </Alert>
      )}
      <Description
        key={project.data.description}
        initial={project.data.description}
        disabled={trashed}
        onSave={(description) => save({ description })}
      />

      <Group justify="space-between">
        <Title order={4}>Sessions</Title>
        {!trashed && (
          <Group gap="xs">
            <Button
              size="xs"
              onClick={() => create.mutate()}
              loading={create.isPending}
            >
              New session
            </Button>
            <Button
              size="xs"
              color="red"
              variant="light"
              onClick={() => actions.confirmTrash(project.data)}
            >
              Move to trash
            </Button>
          </Group>
        )}
      </Group>
      {sessions.isPending && <Loader size="sm" />}
      {sessions.isError && <Alert color="red">{sessions.error.message}</Alert>}
      {sessions.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No sessions.
        </Text>
      )}
      <Stack gap={0}>
        {sessions.data?.map((s) => (
          <NavLink
            key={s.id}
            renderRoot={(props) => (
              <Link
                {...props}
                to="/sessions/$sessionId"
                params={{ sessionId: s.id }}
              />
            )}
            label={s.title}
            description={new Date(s.created_at).toLocaleString()}
            rightSection={<SessionMenu session={s} />}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/** The description, saved with its button. Remounted when it changes. */
function Description({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled: boolean;
  onSave: (description: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);

  return (
    <Stack gap="xs">
      <Textarea
        label="Description"
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
              .catch(showError("Could not save the description"))
              .finally(() => setSaving(false));
          }}
        >
          Save description
        </Button>
      )}
    </Stack>
  );
}
