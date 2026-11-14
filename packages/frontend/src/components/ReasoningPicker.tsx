import { Loader, Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { modelKeys } from "../queries";

const INPUT_FIRST: ("label" | "input" | "description" | "error")[] = [
  "label",
  "input",
  "description",
  "error",
];

export function effortLabel(effort: string): string {
  return effort === "none" ? "Off" : effort;
}

export function ReasoningPicker(props: {
  model: string | undefined;
  value: string | null;
  onChange: (effort: string | null) => void;
  placeholder: string;
  label?: string;
  description?: string;
  disabled?: boolean;
  w?: number | string;
  size?: "xs" | "sm";
}) {
  const levels = useQuery({
    queryKey: modelKeys.reasoningLevel(props.model),
    queryFn: () => api.reasoningLevels(props.model),
    retry: false,
  });

  const listed =
    levels.data && "levels" in levels.data ? levels.data.levels : [];
  const values = ["none", ...listed];

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
