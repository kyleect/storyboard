import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** How an effort value reads in the UI. */
export function effortLabel(effort: string): string {
  return effort === "none" ? "Off" : effort;
}

/**
 * Picks the reasoning effort for the next message: Off ("none"), or one of
 * the levels the model's chat template supports (read from llama-server's
 * /props without loading the model). Clearing returns the session to the
 * default from Settings.
 */
export function ReasoningPicker(props: {
  /** The model the levels are read for; undefined: the server's default. */
  model: string | undefined;
  value: string | null;
  onChange: (effort: string | null) => void;
  disabled?: boolean;
}) {
  const levels = useQuery({
    queryKey: ["reasoning-levels", props.model ?? null],
    queryFn: () => api.reasoningLevels(props.model),
    retry: false,
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
  });

  const values = ["none", ...(levels.data?.levels ?? [])];
  // Keep a chosen effort visible even if the model does not list it.
  if (props.value && !values.includes(props.value)) values.push(props.value);

  const fallback = settings.data?.effective.reasoningEffort;
  const placeholder = fallback
    ? `Reasoning: default (${effortLabel(fallback)})`
    : "Reasoning: default (server decides)";

  return (
    <Select
      aria-label="Reasoning"
      size="xs"
      w={220}
      clearable
      data={values.map((v) => ({ value: v, label: effortLabel(v) }))}
      value={props.value}
      onChange={(value) => props.onChange(value)}
      placeholder={placeholder}
      disabled={props.disabled ?? false}
      {...(levels.isError
        ? {
            description: `Levels unavailable: ${levels.error.message}`,
          }
        : levels.data && levels.data.levels.length === 0
          ? { description: "This model lists no effort levels." }
          : {})}
    />
  );
}
