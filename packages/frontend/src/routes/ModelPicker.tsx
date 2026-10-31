import { ActionIcon, Group, Select, Text, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Picks the model for the next message. The list comes from llama-server
 * (router mode lists every model it knows). Clearing the picker returns the
 * session to the default model from Settings.
 */
export function ModelPicker(props: {
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const models = useQuery({ queryKey: ["models"], queryFn: api.listModels });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const status = new Map((models.data ?? []).map((m) => [m.id, m.status]));
  const ids = (models.data ?? []).map((m) => m.id);
  // Keep a chosen model visible even if the server no longer lists it.
  if (props.value && !ids.includes(props.value)) ids.unshift(props.value);

  const fallback = settings.data?.effective.model;
  const placeholder = fallback
    ? `Default (${fallback})`
    : "Default (none set; the server decides)";

  return (
    <Group gap={4} wrap="nowrap">
      <Select
        aria-label="Model"
        size="xs"
        w={320}
        searchable
        clearable
        data={ids}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        placeholder={placeholder}
        disabled={props.disabled ?? false}
        nothingFoundMessage="No matching model"
        {...(models.isError
          ? { error: `Could not list models: ${models.error.message}` }
          : {})}
        renderOption={({ option }) => (
          <Group gap="xs" justify="space-between" w="100%" wrap="nowrap">
            <Text size="xs">{option.label}</Text>
            {status.get(option.value) && (
              <Text size="xs" c="dimmed">
                {status.get(option.value)}
              </Text>
            )}
          </Group>
        )}
      />
      <Tooltip label="Refresh the model list">
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label="Refresh the model list"
          loading={models.isFetching}
          onClick={() => void models.refetch()}
        >
          ↻
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
