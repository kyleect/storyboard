import {
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { showError } from "../lib/notify";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type WorkspaceAttachment, type WorkspaceOwner } from "../api";
import { workspaceKeys } from "../queries";

export function AttachedWorkspaces({
  owner,
  id,
  disabled = false,
}: {
  owner: WorkspaceOwner;
  id: string;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const attached = useQuery({
    queryKey: workspaceKeys.attached(owner, id),
    queryFn: () => api.listAttachedWorkspaces(owner, id),
  });
  const all = useQuery({
    queryKey: workspaceKeys.list(false),
    queryFn: () => api.listWorkspaces(false),
  });
  const [pick, setPick] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
  const attach = useMutation({
    mutationFn: (v: { workspaceId: string; readOnly: boolean }) =>
      api.attachWorkspace(owner, id, v.workspaceId, v.readOnly),
    onSuccess: () => {
      setPick(null);
      refresh();
    },
    onError: showError("Could not attach"),
  });
  const detach = useMutation({
    mutationFn: (workspaceId: string) =>
      api.detachWorkspace(owner, id, workspaceId),
    onSuccess: refresh,
    onError: showError("Could not detach"),
  });
  const own = (a: WorkspaceAttachment) =>
    a.from === (owner === "projects" ? "project" : "session");
  const taken = new Set(
    (attached.data ?? []).filter(own).map((a) => a.workspace.id),
  );
  const choices = (all.data ?? [])
    .filter((w) => !taken.has(w.id))
    .map((w) => ({ value: w.id, label: w.name }));
  return (
    <Stack gap="xs">
      <Title order={5}>Workspaces</Title>
      {attached.isPending && <Loader size="xs" />}
      {attached.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          None attached.
        </Text>
      )}
      {attached.data?.map((a) => (
        <Group
          key={`${a.from}/${a.workspace.id}`}
          justify="space-between"
          wrap="nowrap"
        >
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm">
              {a.workspace.name}{" "}
              <Badge
                size="xs"
                variant="light"
                color={a.effectiveWritable ? "orange" : "gray"}
              >
                {a.effectiveWritable ? "writable" : "read-only"}
              </Badge>
              {a.from !== (owner === "projects" ? "project" : "session") && (
                <Text span size="xs" c="dimmed">
                  {" "}
                  from the project
                </Text>
              )}
            </Text>
          </Stack>
          {own(a) && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={disabled}
              onClick={() => detach.mutate(a.workspace.id)}
            >
              Detach
            </Button>
          )}
        </Group>
      ))}
      {!disabled && choices.length > 0 && (
        <Group align="flex-end" gap="xs">
          <Select
            size="xs"
            aria-label="Workspace to attach"
            placeholder="Attach a workspace"
            data={choices}
            value={pick}
            onChange={setPick}
          />
          <Checkbox
            size="xs"
            label="Read-only here"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.currentTarget.checked)}
          />
          <Button
            size="xs"
            disabled={pick === null}
            loading={attach.isPending}
            onClick={() =>
              pick !== null && attach.mutate({ workspaceId: pick, readOnly })
            }
          >
            Attach
          </Button>
        </Group>
      )}
    </Stack>
  );
}
