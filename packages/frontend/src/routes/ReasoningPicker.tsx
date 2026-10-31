import { Loader, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

const INPUT_FIRST: ("label" | "input" | "description" | "error")[] = [
  "label",
  "input",
  "description",
  "error",
];

/** How an effort value reads in the UI. */
export function effortLabel(effort: string): string {
  return effort === "none" ? "Off" : effort;
}

/**
 * Picks a reasoning effort: Off ("none"), or one of the levels the model's
 * chat template supports (read from llama-server's /props without loading
 * the model). Clearing it means "no effort chosen".
 * Used by the chat (the session's effort) and by Settings (the default).
 */
export function ReasoningPicker(props: {
  /** The model the levels are read for; undefined: the server's default. */
  model: string | undefined;
  value: string | null;
  onChange: (effort: string | null) => void;
  /** Shown when nothing is chosen. */
  placeholder: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  w?: number | string;
  size?: "xs" | "sm";
}) {
  const levels = useQuery({
    queryKey: ["reasoning-levels", props.model ?? null],
    queryFn: () => api.reasoningLevels(props.model),
    retry: false,
  });

  const listed =
    levels.data && "levels" in levels.data ? levels.data.levels : [];
  const values = ["none", ...listed];
  // Keep a chosen effort visible even if the model does not list it.
  if (props.value && !values.includes(props.value)) values.push(props.value);

  const note = levels.isError
    ? `Levels unavailable: ${levels.error.message}`
    : levels.data && "unavailable" in levels.data
      ? `Levels unavailable: ${levels.data.unavailable}`
      : levels.data && listed.length === 0
        ? "This model lists no effort levels."
        : undefined;
  const description = [props.description, note].filter(Boolean).join(" ");

  return (
    <Select
      aria-label={props.label ?? "Reasoning"}
      {...(props.label ? { label: props.label } : {})}
      {...(description ? { description } : {})}
      // Unlabelled (chat): messages go under the input so pickers side by
      // side stay aligned. Labelled (Settings): the usual order.
      {...(props.label ? {} : { inputWrapperOrder: INPUT_FIRST })}
      size={props.size ?? "xs"}
      w={props.w ?? 260}
      clearable
      data={values.map((v) => ({ value: v, label: effortLabel(v) }))}
      value={props.value}
      onChange={(value) => props.onChange(value)}
      placeholder={props.placeholder}
      disabled={props.disabled ?? false}
      {...(levels.isFetching
        ? {
            rightSection: (
              <Loader size={14} aria-label="Loading reasoning levels" />
            ),
          }
        : {})}
    />
  );
}
