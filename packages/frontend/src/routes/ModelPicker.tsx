import {
  ActionIcon,
  Group,
  Loader,
  Select,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api";

const INPUT_FIRST: ("label" | "input" | "description" | "error")[] = [
  "label",
  "input",
  "description",
  "error",
];

/** Router states in which a model needs no load request. */
const RUNNING = new Set(["loaded", "loading", "sleeping"]);

/**
 * Picks a model from the list llama-server reports (router mode lists every
 * model it knows, with its status). Clearing it means "no model chosen".
 * Used by the chat (the session's model) and by Settings (the default).
 *
 * With `loadOnSelect`, picking a model that a router reports as not running
 * asks the router to load it (clearing loads `defaultModel`). While any model
 * is loading the list is refreshed every second, and the status of the model
 * in use is shown under the picker.
 */
export function ModelPicker(props: {
  value: string | null;
  onChange: (model: string | null) => void;
  /** Shown when nothing is chosen. */
  placeholder: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  w?: number;
  size?: "xs" | "sm";
  loadOnSelect?: boolean;
  /** The model used when none is chosen. */
  defaultModel?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const models = useQuery({
    queryKey: ["models"],
    queryFn: api.listModels,
    refetchInterval: (q) =>
      q.state.data?.some((m) => m.status === "loading") ? 1000 : false,
  });
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
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not load the model",
        message: err.message,
      }),
  });

  // The model in use and what the router says about it.
  const inUse = props.value ?? props.defaultModel;
  const info = models.data?.find((m) => m.id === inUse);
  // Once it has loaded, what llama-server reports about it (its reasoning
  // levels) can change.
  const previous = useRef(info?.status);
  useEffect(() => {
    if (previous.current === "loading" && info?.status === "loaded") {
      void queryClient.invalidateQueries({ queryKey: ["reasoning-levels"] });
    }
    previous.current = info?.status;
  }, [info?.status, queryClient]);

  const choose = (value: string | null) => {
    props.onChange(value);
    if (!props.loadOnSelect) return;
    const target = value ?? props.defaultModel;
    const listed = models.data?.find((m) => m.id === target);
    // Only routers report a status; a single-model server has nothing to load.
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
  // Keep a chosen model visible even if the server no longer lists it.
  if (props.value && !ids.includes(props.value)) ids.unshift(props.value);

  return (
    // Labelled (Settings): the refresh button lines up with the input's
    // bottom. Unlabelled (chat): with its top.
    <Group
      gap={4}
      wrap="nowrap"
      align={props.label ? "flex-end" : "flex-start"}
    >
      <Select
        aria-label={props.label ?? "Model"}
        {...(props.label ? { label: props.label } : {})}
        {...(description ? { description } : {})}
        // Unlabelled (chat): messages go under the input so pickers side by
        // side stay aligned. Labelled (Settings): the usual order.
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
          variant="subtle"
          size={props.size === "sm" ? "lg" : "sm"}
          mt={props.label ? 0 : 4}
          aria-label="Refresh the model list"
          disabled={models.isFetching}
          onClick={() => {
            void models.refetch();
            // Levels depend on whether a model is loaded, which may have changed.
            void queryClient.invalidateQueries({
              queryKey: ["reasoning-levels"],
            });
          }}
        >
          ↻
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
