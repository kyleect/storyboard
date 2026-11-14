import {
  Alert,
  Button,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ErrorFilter } from "../../api";
import { errorKeys } from "../../queries";
import { showError } from "../../lib/notify";
import {
  confirmClear,
  ErrorList,
  withoutKeys,
} from "../../components/ErrorList";

const RUNS = "\u0000runs";
const NO_PROJECT = "none";

export function ErrorsPage() {
  const [filter, setFilter] = useState<ErrorFilter>({});
  const errors = useQuery({
    queryKey: errorKeys.list(filter),
    queryFn: () => api.listErrors(filter),
  });
  const options = useQuery({
    queryKey: errorKeys.filters(),
    queryFn: api.errorFilters,
  });
  const clear = useMutation({
    mutationFn: () => api.clearErrors(),
    onError: showError("Could not clear the errors"),
  });

  const set = (key: "sessionId" | "projectId", value: string | undefined) =>
    setFilter((f) => ({
      ...withoutKeys(f, [key]),
      ...(value ? { [key]: value } : {}),
    }));
  const toolValue = filter.source === "run" ? RUNS : (filter.tool ?? null);

  return (
    <Stack h="calc(100vh - 2 * var(--mantine-spacing-md))" gap="sm">
      <Group justify="space-between">
        <Title order={3}>Errors</Title>
        <Button
          color="red"
          variant="light"
          size="xs"
          disabled={!errors.data?.length}
          loading={clear.isPending}
          onClick={() =>
            confirmClear("every error", () => {
              clear.mutate();
            })
          }
        >
          Clear
        </Button>
      </Group>
      <Group gap="xs">
        <Select
          aria-label="Session"
          size="xs"
          clearable
          placeholder="Every session"
          data={(options.data?.sessions ?? []).map((s) => ({
            value: s.id,
            label: s.title,
          }))}
          value={filter.sessionId ?? null}
          onChange={(v) => set("sessionId", v ?? undefined)}
        />
        <Select
          aria-label="Project"
          size="xs"
          clearable
          placeholder="Every project"
          data={[
            { value: NO_PROJECT, label: "No project" },
            ...(options.data?.projects ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            })),
          ]}
          value={filter.projectId ?? null}
          onChange={(v) => set("projectId", v ?? undefined)}
        />
        <Select
          aria-label="Tool or source"
          size="xs"
          clearable
          placeholder="Every tool and run"
          data={[
            ...(options.data?.runs
              ? [{ value: RUNS, label: "Failed runs" }]
              : []),
            ...(options.data?.tools ?? []).map((t) => ({ value: t, label: t })),
          ]}
          value={toolValue}
          onChange={(v) =>
            setFilter((f) => {
              const rest = withoutKeys(f, ["source", "tool"]);
              if (v === null) return rest;
              return v === RUNS
                ? { ...rest, source: "run" }
                : { ...rest, source: "tool", tool: v };
            })
          }
        />
      </Group>
      {options.isError && (
        <Text c="red" size="xs">
          {options.error.message}
        </Text>
      )}
      <ScrollArea style={{ flex: 1 }}>
        {errors.isPending ? (
          <Loader />
        ) : errors.isError ? (
          <Alert color="red">{errors.error.message}</Alert>
        ) : (
          <ErrorList errors={errors.data} showSession />
        )}
      </ScrollArea>
    </Stack>
  );
}
