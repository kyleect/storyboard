import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../api";
import { sessionKeys } from "../../queries";
import { PAGE_SIZES, useSessionsPrefs } from "../../stores/sessionsPrefs";
import { UsageBadge } from "../../components/ContextMeter";
import { useSessionActions } from "../../hooks/useSessionActions";
import { UnreadDot } from "../../components/UnreadDot";
import { SessionMenu } from "../../components/SessionMenu";
import { showError } from "../../lib/notify";

export function SessionsPage({ projectId }: { projectId: string | null }) {
  return <SessionsTable key={projectId ?? "none"} projectId={projectId} />;
}

function SessionsTable({ projectId }: { projectId: string | null }) {
  const { direction, pageSize, setDirection, setPageSize } = useSessionsPrefs();
  const actions = useSessionActions();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [everyone, setEveryone] = useState<readonly string[] | null>(null);

  const request = { projectId, direction, page, pageSize };
  const list = useQuery({
    queryKey: sessionKeys.page(request),
    queryFn: () => api.listSessionsPage(request),
    placeholderData: keepPreviousData,
  });

  const lastPage = list.data
    ? Math.max(1, Math.ceil(list.data.total / pageSize))
    : null;
  if (lastPage !== null && page > lastPage) setPage(lastPage);

  const selectAll = useMutation({
    mutationFn: () => api.listSessionIds(projectId),
    onSuccess: ({ sessions }) => {
      const ids = sessions.filter((s) => !s.running).map((s) => s.id);
      setEveryone(ids);
      setSelected(new Set(ids));
    },
    onError: showError("Could not select the sessions"),
  });

  const clear = () => {
    setSelected(new Set());
    setEveryone(null);
  };

  const allSelected =
    everyone !== null &&
    everyone.length > 0 &&
    everyone.every((id) => selected.has(id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const flipDirection = () => {
    setDirection(direction === "desc" ? "asc" : "desc");
    setPage(1);
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Chats</Title>
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {selected.size} selected
          </Text>
          <Button
            size="xs"
            variant="default"
            disabled={selected.size === 0}
            onClick={clear}
          >
            Clear selection
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            disabled={selected.size === 0}
            onClick={() => actions.confirmTrashMany([...selected], clear)}
          >
            Move to trash
          </Button>
        </Group>
      </Group>

      {list.isPending && <Loader size="sm" />}
      {list.isError && <Alert color="red">{list.error.message}</Alert>}
      {list.data && total === 0 && (
        <Text size="sm" c="dimmed">
          No sessions.
        </Text>
      )}

      {total > 0 && (
        <Table verticalSpacing="xs" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>
                <Checkbox
                  size="xs"
                  aria-label="Select all sessions"
                  checked={allSelected}
                  indeterminate={selected.size > 0 && !allSelected}
                  disabled={selectAll.isPending}
                  onChange={() => {
                    if (allSelected) clear();
                    else selectAll.mutate();
                  }}
                />
              </Table.Th>
              <Table.Th>Title</Table.Th>
              <Table.Th
                aria-sort={direction === "desc" ? "descending" : "ascending"}
              >
                <UnstyledButton
                  fw={700}
                  fz="inherit"
                  onClick={flipDirection}
                  aria-label={`Created, sorted ${
                    direction === "desc" ? "newest" : "oldest"
                  } first. Click to reverse.`}
                >
                  Created {direction === "desc" ? "↓" : "↑"}
                </UnstyledButton>
              </Table.Th>
              <Table.Th>Context</Table.Th>
              <Table.Th>Agents</Table.Th>
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((s) => (
              <Table.Tr
                key={s.id}
                {...(selected.has(s.id)
                  ? { bg: "var(--mantine-primary-color-light)" }
                  : {})}
              >
                <Table.Td>
                  <Checkbox
                    size="xs"
                    aria-label={`Select ${s.title}`}
                    checked={selected.has(s.id)}
                    disabled={s.running}
                    title={s.running ? "A run is in progress" : undefined}
                    onChange={() => toggle(s.id)}
                  />
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Anchor
                      size="sm"
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
                    {s.unread && !s.running && <UnreadDot />}
                  </Group>
                </Table.Td>
                <Table.Td>{new Date(s.created_at).toLocaleString()}</Table.Td>
                <Table.Td>
                  {s.usage ? (
                    <UsageBadge usage={s.usage} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {s.agents.length > 0 ? (
                    <Group gap={4}>
                      {s.agents.map((a) => (
                        <Badge key={a.id} variant="light" size="sm" tt="none">
                          {a.name}
                        </Badge>
                      ))}
                    </Group>
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <SessionMenu session={s} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {total > 0 && (
        <Group justify="space-between">
          <Group gap="xs">
            <Select
              aria-label="Sessions per page"
              w={80}
              allowDeselect={false}
              data={PAGE_SIZES.map(String)}
              value={String(pageSize)}
              onChange={(value) => {
                const size = PAGE_SIZES.find((n) => String(n) === value);
                if (size === undefined) return;
                setPageSize(size);
                setPage(1);
              }}
            />
            <Text size="sm" c="dimmed">
              per page, {total} {total === 1 ? "session" : "sessions"}
            </Text>
          </Group>
          {lastPage !== null && lastPage > 1 && (
            <Pagination
              total={lastPage}
              value={Math.min(page, lastPage)}
              onChange={setPage}
            />
          )}
        </Group>
      )}
    </Stack>
  );
}
