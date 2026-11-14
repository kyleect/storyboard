import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { confirmAction } from "../../../lib/confirm";
import { useProjects } from "../../../hooks/useProjects";
import { modals } from "@mantine/modals";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type Session, type SettingsView } from "../../../api";
import { trashKeys } from "../../../queries";
import { useSessionActions } from "../../../hooks/useSessionActions";
import { showError } from "../../../lib/notify";
import { TRASH_KEYS, useSettingsForm } from "../lib/settings-form";

export function TrashRetention({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, TRASH_KEYS, {
    trashRetentionDays: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <NumberInput
          label="Days in the trash"
          description={
            envNote("trashRetentionDays") ??
            "Items in the trash longer than this are deleted when the backend starts. 0: never."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.trashRetentionDays}
          {...form.getInputProps("trashRetentionDays")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
export function TrashSection() {
  const actions = useSessionActions();
  const trash = useQuery({ queryKey: trashKeys.all, queryFn: api.getTrash });
  const projects = useProjects();
  const [busy, setBusy] = useState<string | null>(null);

  const run = (id: string, work: () => Promise<unknown>, failed: string) => {
    setBusy(id);
    work()
      .catch(showError(failed))
      .finally(() => setBusy(null));
  };

  const confirmDelete = (
    title: string,
    body: string,
    work: () => Promise<unknown>,
  ) =>
    modals.openConfirmModal({
      title,
      children: <Text size="sm">{body}</Text>,
      labels: { confirm: "Delete forever", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        work()
          .then(() => actions.refreshProjects())
          .catch(showError("Could not delete"));
      },
    });

  const confirmEmpty = () =>
    confirmAction({
      title: "Empty the trash?",
      message: (
        <>Everything in the trash will be deleted. This cannot be undone.</>
      ),
      confirm: "Empty trash",
      cancel: "Cancel",
      danger: true,
      onConfirm: () => {
        api
          .emptyTrash()
          .then(() => actions.refreshProjects())
          .catch(showError("Could not empty the trash"));
      },
    });

  const trashedProjects = trash.data?.projects ?? [];
  const sessions = trash.data?.sessions ?? [];
  const branches = trash.data?.branches ?? [];
  const empty =
    trashedProjects.length === 0 &&
    sessions.length === 0 &&
    branches.length === 0;
  const projectOf = (s: Session) =>
    s.project_id === null
      ? undefined
      : (trashedProjects.find((p) => p.id === s.project_id) ??
        projects.data?.find((p) => p.id === s.project_id));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={4}>Trash</Title>
        {!empty && (
          <Button size="xs" color="red" variant="light" onClick={confirmEmpty}>
            Empty trash
          </Button>
        )}
      </Group>
      {trash.isPending && <Loader size="sm" />}
      {trash.isError && <Alert color="red">{trash.error.message}</Alert>}
      {trash.data && empty && (
        <Text size="sm" c="dimmed">
          The trash is empty.
        </Text>
      )}
      {trashedProjects.map((p) => (
        <Paper key={p.id} p="xs">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={0} miw={0}>
              <Text size="sm" fw={500} truncate>
                Project: {p.name}
              </Text>
              <Text size="xs" c="dimmed">
                Trashed {new Date(p.trashed_at ?? "").toLocaleString()} ·{" "}
                {p.sessions.length === 1
                  ? "1 session"
                  : `${p.sessions.length} sessions`}
              </Text>
              {p.sessions.map((s) => (
                <Anchor
                  key={s.id}
                  size="xs"
                  renderRoot={(props) => (
                    <Link
                      {...props}
                      to="/sessions/$sessionId"
                      params={{ sessionId: s.id }}
                    />
                  )}
                >
                  {s.title}
                </Anchor>
              ))}
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="light"
                loading={busy === p.id}
                onClick={() =>
                  run(
                    p.id,
                    () =>
                      api
                        .restoreProject(p.id)
                        .then(() => actions.refreshProjects()),
                    "Could not restore",
                  )
                }
              >
                Restore
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={() =>
                  confirmDelete(
                    "Delete project forever?",
                    `“${p.name}” and all its sessions, including any trashed on their own, will be deleted. This cannot be undone.`,
                    () => api.deleteProject(p.id),
                  )
                }
              >
                Delete forever
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
      {sessions.map((s) => {
        const project = projectOf(s);
        return (
          <Paper key={s.id} p="xs">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={0} miw={0}>
                <Text size="sm" truncate>
                  {s.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {project ? `In ${project.name} · ` : ""}
                  Trashed {new Date(s.trashed_at ?? "").toLocaleString()}
                </Text>
              </Stack>
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  variant="default"
                  renderRoot={(props) => (
                    <Link
                      {...props}
                      to="/sessions/$sessionId"
                      params={{ sessionId: s.id }}
                    />
                  )}
                >
                  Open
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  loading={busy === s.id}
                  onClick={() =>
                    run(
                      s.id,
                      () =>
                        actions.restore(
                          s,
                          project?.trashed_at ? project : null,
                        ),
                      "Could not restore",
                    )
                  }
                >
                  Restore
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="subtle"
                  onClick={() =>
                    confirmDelete(
                      "Delete forever?",
                      `“${s.title}” and its whole transcript will be deleted. This cannot be undone.`,
                      () => api.deleteSession(s.id),
                    )
                  }
                >
                  Delete forever
                </Button>
              </Group>
            </Group>
          </Paper>
        );
      })}
      {branches.map((b) => (
        <Paper key={b.messageId} p="xs">
          <Group justify="space-between" wrap="nowrap">
            <Stack gap={0} miw={0}>
              <Text size="sm" truncate>
                Branch: {b.preview === "" ? "(no text)" : b.preview}
              </Text>
              <Text size="xs" c="dimmed">
                In {b.sessionTitle} · {b.messages}{" "}
                {b.messages === 1 ? "message" : "messages"} · Deleted{" "}
                {new Date(b.trashedAt).toLocaleString()}
              </Text>
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Button
                size="xs"
                variant="light"
                loading={busy === b.messageId}
                onClick={() =>
                  run(
                    b.messageId,
                    () =>
                      api
                        .restoreBranch(b.messageId)
                        .then(() => actions.refreshProjects()),
                    "Could not restore",
                  )
                }
              >
                Restore
              </Button>
              <Button
                size="xs"
                color="red"
                variant="subtle"
                onClick={() =>
                  confirmDelete(
                    "Delete branch forever?",
                    "This branch and everything after it will be deleted. This cannot be undone.",
                    () => api.deleteTrashedBranch(b.messageId),
                  )
                }
              >
                Delete forever
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}
