import {
  Badge,
  Button,
  Code,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { readSchemaForm, type Form, type SchemaNode } from "@harness/core";
import {
  api,
  type DataDetail,
  type DataItem,
  type DataOwner,
  type DataVersion,
} from "../../api";
import { dataKeys } from "../../queries";
import { showError } from "../../hooks/useSessionActions";

/*
 * Data (schemas and data design, decisions 19 to 25, 44): the pieces the
 * Structured Data and Agents views share. Forms are made from the schema
 * (decisions 19, 20); the backend's checks have the final word on save
 * (plan P3), and their problems show next to the fields.
 */

export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

function useRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: dataKeys.all });
  };
}

/** The form for a schema version, titled for what is being done. */
export const formOf = (body: unknown, submitLabel: string): Form => ({
  ...readSchemaForm(body as SchemaNode),
  submitLabel,
  skipLabel: "Cancel",
});

/**
 * The backend's problems as form problems, by question path: "/inv/0/item"
 * becomes "inv.0.item"; a missing property is shown on that property. A
 * scalar form's one question is "value". Undefined when there are none.
 */
export function errorsFromMessage(
  form: Form,
  message: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of message.split("\n")) {
    const m = /^- (\(value\)|\/\S*): (.*)$/.exec(line.trim());
    if (!m) continue;
    const [, at = "", text = ""] = m;
    let steps = at === "(value)" ? [] : at.slice(1).split("/");
    const missing = /^missing required property '(.+)'\.$/.exec(text);
    if (missing?.[1]) steps = [...steps, missing[1]];
    if (form.scalar) steps = ["value", ...steps];
    out[steps.join(".")] = missing ? "Answer this question." : text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function Badges({ d }: { d: DataItem }) {
  return (
    <>
      {d.deleted && (
        <Badge size="xs" variant="light" color="red">
          deleted
        </Badge>
      )}
      {d.outOfDate && (
        <Badge size="xs" variant="light" color="yellow">
          out of date
        </Badge>
      )}
      {!d.schemaInScope && (
        <Badge size="xs" variant="light" color="gray">
          schema not available
        </Badge>
      )}
    </>
  );
}

/** A piece of data's saved states; one can be made current (decision 24). */
export function VersionsModal({
  owner,
  item,
  readOnly,
  onClose,
}: {
  owner: DataOwner;
  item: DataDetail;
  readOnly: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const newestFirst = [...item.versions].reverse();
  const [picked, setPicked] = useState<DataVersion | undefined>(newestFirst[0]);
  const restore = useMutation({
    mutationFn: (seq: number) => api.restoreData(owner, item.id, seq),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const latest = newestFirst[0];
  const isCurrent = picked?.seq === latest?.seq && !item.deleted;

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${item.name}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={220} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={
                <Group gap={4}>
                  <Text size="sm">#{v.seq}</Text>
                  <Badge size="xs" variant="light" color="gray">
                    {v.author}
                  </Badge>
                  {v.deleted && (
                    <Badge size="xs" variant="light" color="red">
                      deleted
                    </Badge>
                  )}
                </Group>
              }
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {picked.deleted
                  ? "Deleted here; the content it had is shown."
                  : `On schema version ${picked.schemaVersion}.`}
              </Text>
              {!readOnly && item.schema && (
                <Button
                  size="xs"
                  disabled={picked.deleted || isCurrent}
                  loading={restore.isPending}
                  onClick={() => restore.mutate(picked.seq)}
                >
                  {isCurrent ? "Current" : "Make current"}
                </Button>
              )}
            </Group>
            <Text size="sm" fw={500}>
              {picked.name}
            </Text>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {picked.description}
            </Text>
            <ScrollArea.Autosize mah="50vh">
              <Code block>{JSON.stringify(picked.value, null, 2)}</Code>
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}
