import {
  ActionIcon,
  Group,
  Loader,
  Select,
  Text,
  Tooltip,
} from "@mantine/core";
import { useModels } from "../hooks/useModels";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { modelKeys } from "../queries";

const INPUT_FIRST: ("label" | "input" | "description" | "error")[] = [
  "label",
  "input",
  "description",
  "error",
];

const RUNNING = new Set(["loaded", "loading", "sleeping"]);

export function ModelPicker(props: {
  value: string | null;
  onChange: (model: string | null) => void;
  placeholder: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  w?: number;
  size?: "xs" | "sm";
  loadOnSelect?: boolean;
  defaultModel?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const models = useModels();
  const load = useMutation({
    mutationFn: api.loadModel,
    onSuccess: (result) => {
      if (!result.ok) {
        notifications.show({
          color: "yellow",
          title: "Could not load the model",
          message: result.message,
        });
      }
      void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
    },
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not load the model",
        message: err.message,
      }),
  });

  const inUse = props.value ?? props.defaultModel;
  const info = models.data?.find((m) => m.id === inUse);
  const previous = useRef(info?.status);
  useEffect(() => {
    if (previous.current === "loading" && info?.status === "loaded") {
      void queryClient.invalidateQueries({
        queryKey: modelKeys.reasoningLevels(),
      });
    }
    previous.current = info?.status;
  }, [info?.status, queryClient]);

  const choose = (value: string | null) => {
    props.onChange(value);
    if (!props.loadOnSelect) return;
    const target = value ?? props.defaultModel;
    const listed = models.data?.find((m) => m.id === target);
    if (target && listed?.status && !RUNNING.has(listed.status)) {
      load.mutate(target);
    }
  };

  const loadingModel = load.isPending || info?.status === "loading";
  const loadNote = loadingModel
    ? `Loading ${inUse ?? "model"}…`
    : info?.failed
      ? `Loading ${inUse ?? "the model"} failed; see llama-server's log.`
      : undefined;
  const description = [props.description, loadNote].filter(Boolean).join(" ");

  const status = new Map((models.data ?? []).map((m) => [m.id, m.status]));
  const ids = (models.data ?? []).map((m) => m.id);
  if (props.value && !ids.includes(props.value)) ids.unshift(props.value);

  return (
    <Group
      gap={4}
      wrap="nowrap"
      align={props.label ? "flex-end" : "flex-start"}
    >
      <Select
        aria-label={props.label ?? "Model"}
        {...(props.label ? { label: props.label } : {})}
        {...(description ? { description } : {})}
        {...(props.label ? {} : { inputWrapperOrder: INPUT_FIRST })}
        size={props.size ?? "xs"}
        w={props.w ?? 320}
        searchable
        clearable
        data={ids}
        value={props.value}
        onChange={choose}
        placeholder={models.isPending ? "Loading models…" : props.placeholder}
        disabled={props.disabled ?? false}
        nothingFoundMessage="No matching model"
        {...(models.isPending || loadingModel
          ? {
              rightSection: (
                <Loader
                  size={14}
                  aria-label={
                    models.isPending ? "Loading models" : "Loading the model"
                  }
                />
              ),
            }
          : {})}
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
      <Tooltip label="Refresh the model list and reasoning levels">
        <ActionIcon
          size={props.size === "sm" ? "lg" : "sm"}
          mt={props.label ? 0 : 4}
          aria-label="Refresh the model list"
          disabled={models.isFetching}
          variant="subtle"
          onClick={() => {
            void models.refetch();
            void queryClient.invalidateQueries({
              queryKey: modelKeys.reasoningLevels(),
            });
          }}
        >
          ↻
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
