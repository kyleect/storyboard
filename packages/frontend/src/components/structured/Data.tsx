import { Badge, Code, Group, Stack, Text } from "@mantine/core";
import utils from "../../styles/utilities.module.css";
import { VersionsModal as GenericVersionsModal } from "../VersionsModal";
import { useQueryClient } from "@tanstack/react-query";
import { readSchemaForm, type Form, type SchemaNode } from "@harness/core";
import { api, type DataDetail, type DataItem, type DataOwner } from "../../api";
import { dataKeys } from "../../queries";

function useRefresh() {
  const queryClient = useQueryClient();

  return async () => {
    await queryClient.invalidateQueries({ queryKey: dataKeys.all });
  };
}

export const formOf = (body: unknown, submitLabel: string): Form => ({
  ...readSchemaForm(body as SchemaNode),
  submitLabel,
  skipLabel: "Cancel",
});

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
      {d.deleted && <Badge color="red">deleted</Badge>}
      {d.outOfDate && <Badge color="yellow">out of date</Badge>}
      {!d.schemaInScope && <Badge color="gray">schema not available</Badge>}
    </>
  );
}

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
  const latest = item.versions.at(-1);

  return (
    <GenericVersionsModal
      title={`Versions of ${item.name}`}
      versions={item.versions}
      listWidth={220}
      bodyHeight="50vh"
      label={(v) => (
        <Group gap={4}>
          <Text size="sm">#{v.seq}</Text>
          <Badge color="gray">{v.author}</Badge>
          {v.deleted && <Badge color="red">deleted</Badge>}
        </Group>
      )}
      note={(v) => (
        <Text size="sm" c="dimmed">
          {v.deleted
            ? "Deleted here; the content it had is shown."
            : `On schema version ${v.schemaVersion}.`}
        </Text>
      )}
      body={(v) => (
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            {v.name}
          </Text>
          <Text size="sm" className={utils.preWrap}>
            {v.description}
          </Text>
          <Code block>{JSON.stringify(v.value, null, 2)}</Code>
        </Stack>
      )}
      restore={
        readOnly || !item.schema
          ? undefined
          : {
              run: (seq) => api.restoreData(owner, item.id, seq),
              afterRestore: refresh,
              isCurrent: (v) => v.seq === latest?.seq && !item.deleted,
              canRestore: (v) => !v.deleted,
            }
      }
      onClose={onClose}
    />
  );
}
