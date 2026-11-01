import {
  Badge,
  Button,
  Checkbox,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Radio,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  checkAnswers,
  type Answers,
  type Form,
  type FormField,
  type InputAnswer,
} from "@harness/core";

/*
 * A form the model asked with `ask_user`, drawn inline in the chat where
 * the call is (input forms design, D9). Open while the run waits for it;
 * afterwards read-only, with the answers filled in. Every question except
 * text offers "Other" (D19, D21).
 */

/** Choices with more options than this use a dropdown (D5). */
export const CHOICE_LIMIT = 6;

/** The value of the "Other" option; not a string a model would write. */
const OTHER = "\u0000other";

export type AskUserState =
  | {
      mode: "open";
      requestId: string;
      busy: boolean;
      onAnswer: (answer: InputAnswer) => void;
    }
  | { mode: "answered"; answers: Answers }
  | { mode: "skipped" }
  /** Not answered, and not open: about to open, or withdrawn. */
  | { mode: "closed" };

/** One question's inputs. `text` is the text answer or the Other text. */
interface FieldState {
  text: string;
  /** Choice and yes/no: the picked option, "yes", "no" or OTHER. */
  pick: string | null;
  /** Multi-choice: the picked options. */
  picks: string[];
  /** Number: as typed while it is not yet a number. */
  num: number | string;
  /** Multi-choice and number: "Other" is ticked. */
  other: boolean;
}

const EMPTY: FieldState = {
  text: "",
  pick: null,
  picks: [],
  num: "",
  other: false,
};

/** A question's inputs from its answer, or its default. */
export function initialState(field: FormField, answer?: unknown): FieldState {
  const given = answer !== undefined;
  switch (field.kind) {
    case "text":
      return {
        ...EMPTY,
        text:
          typeof answer === "string"
            ? answer
            : given
              ? ""
              : (field.default ?? ""),
      };
    case "choice": {
      if (!given) return { ...EMPTY, pick: field.default ?? null };
      if (typeof answer === "string" && field.options.includes(answer))
        return { ...EMPTY, pick: answer };
      return { ...EMPTY, pick: OTHER, text: String(answer) };
    }
    case "multi": {
      const values = given
        ? Array.isArray(answer)
          ? answer.map(String)
          : []
        : (field.default ?? []);
      const others = values.filter((v) => !field.options.includes(v));
      return {
        ...EMPTY,
        picks: values.filter((v) => field.options.includes(v)),
        other: others.length > 0,
        text: others.join(", "),
      };
    }
    case "number": {
      if (!given) return { ...EMPTY, num: field.default ?? "" };
      if (typeof answer === "number") return { ...EMPTY, num: answer };
      return { ...EMPTY, other: true, text: String(answer) };
    }
    case "boolean": {
      const value = given ? answer : field.default;
      if (value === undefined) return EMPTY;
      if (typeof value === "boolean")
        return { ...EMPTY, pick: value ? "yes" : "no" };
      return { ...EMPTY, pick: OTHER, text: String(value) };
    }
  }
}

/** A question's answer from its inputs; undefined when unanswered. */
export function answerOf(field: FormField, s: FieldState): unknown {
  switch (field.kind) {
    case "text":
      return s.text.trim() === "" ? undefined : s.text;
    case "choice":
      return s.pick === null ? undefined : s.pick === OTHER ? s.text : s.pick;
    case "multi": {
      if (s.picks.length === 0 && !s.other) return undefined;
      return [...s.picks, ...(s.other ? [s.text] : [])];
    }
    case "number":
      if (s.other) return s.text;
      if (typeof s.num === "number") return s.num;
      return s.num.trim() === "" ? undefined : Number(s.num);
    case "boolean":
      return s.pick === null
        ? undefined
        : s.pick === OTHER
          ? s.text
          : s.pick === "yes";
  }
}

/**
 * Inputs start from the answers or defaults when the form mounts; give it a
 * `key` that changes with the state so an answered form shows its answers.
 */
export function AskUserForm({
  form,
  state,
}: {
  form: Form;
  state: AskUserState;
}) {
  const open = state.mode === "open";
  const answers = state.mode === "answered" ? state.answers : {};
  const [values, setValues] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [f.name, initialState(f, answers[f.name])]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ref = useRef<HTMLDivElement>(null);
  const requestId = open ? state.requestId : null;

  // A form that opens is scrolled into view (D9).
  useEffect(() => {
    if (requestId) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [requestId]);

  const set = (name: string, change: Partial<FieldState>) => {
    setValues((v) => ({ ...v, [name]: { ...(v[name] ?? EMPTY), ...change } }));
    setErrors((e) =>
      Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)),
    );
  };

  const submit = () => {
    if (!open) return;
    const given: Answers = {};
    for (const f of form.fields) {
      const a = answerOf(f, values[f.name] ?? EMPTY);
      if (a !== undefined) given[f.name] = a;
    }
    const checked = checkAnswers(form, given);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    state.onAnswer({ outcome: "answered", answers: checked.answers });
  };

  return (
    <Paper
      ref={ref}
      p="sm"
      withBorder
      data-request-id={requestId ?? undefined}
      {...(open ? {} : { bg: "var(--mantine-color-default-hover)" })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack gap="sm">
          <Group gap="xs" justify="space-between">
            <Text fw={600}>{form.title ?? "Questions"}</Text>
            {state.mode === "answered" && (
              <Badge size="sm" variant="light" color="green">
                Answered
              </Badge>
            )}
            {state.mode === "skipped" && (
              <Badge size="sm" variant="light" color="gray">
                Skipped
              </Badge>
            )}
          </Group>
          {form.description && (
            <Text size="sm" c="dimmed">
              {form.description}
            </Text>
          )}
          {form.fields.map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              value={values[f.name] ?? EMPTY}
              error={errors[f.name]}
              disabled={!open}
              onChange={(change) => set(f.name, change)}
            />
          ))}
          {errors[""] && (
            <Text size="sm" c="red">
              {errors[""]}
            </Text>
          )}
          {open && (
            <Group gap="xs" justify="flex-end">
              <Button
                variant="default"
                disabled={state.busy}
                onClick={() => state.onAnswer({ outcome: "skipped" })}
              >
                Skip
              </Button>
              <Button type="submit" loading={state.busy}>
                Submit
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Paper>
  );
}

function FieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: FormField;
  value: FieldState;
  error: string | undefined;
  disabled: boolean;
  onChange: (change: Partial<FieldState>) => void;
}) {
  const common = {
    label: field.label,
    description: field.help,
    withAsterisk: field.required,
    error,
    disabled,
  };
  const otherBox = (shown: boolean) =>
    shown ? (
      <TextInput
        aria-label={`${field.label}: other`}
        placeholder="Your answer"
        value={value.text}
        disabled={disabled}
        onChange={(e) => onChange({ text: e.currentTarget.value })}
      />
    ) : null;

  switch (field.kind) {
    case "text":
      return field.multiline ? (
        <Textarea
          {...common}
          autosize
          minRows={2}
          maxRows={10}
          maxLength={field.maxLength}
          value={value.text}
          onChange={(e) => onChange({ text: e.currentTarget.value })}
        />
      ) : (
        <TextInput
          {...common}
          maxLength={field.maxLength}
          value={value.text}
          onChange={(e) => onChange({ text: e.currentTarget.value })}
        />
      );

    case "choice":
      return (
        <Stack gap={4}>
          {field.options.length <= CHOICE_LIMIT ? (
            <Radio.Group
              {...common}
              value={value.pick}
              onChange={(pick) => onChange({ pick })}
            >
              <Stack gap={6} mt={4}>
                {field.options.map((o) => (
                  <Radio key={o} value={o} label={o} disabled={disabled} />
                ))}
                <Radio value={OTHER} label="Other" disabled={disabled} />
              </Stack>
            </Radio.Group>
          ) : (
            <Select
              {...common}
              data={[...field.options, { value: OTHER, label: "Other…" }]}
              value={value.pick}
              clearable={!field.required}
              onChange={(pick) => onChange({ pick })}
            />
          )}
          {otherBox(value.pick === OTHER)}
        </Stack>
      );

    case "multi": {
      const selected = [...value.picks, ...(value.other ? [OTHER] : [])];
      const pickAll = (all: string[]) =>
        onChange({
          picks: all.filter((v) => v !== OTHER),
          other: all.includes(OTHER),
        });
      return (
        <Stack gap={4}>
          {field.options.length <= CHOICE_LIMIT ? (
            <Checkbox.Group {...common} value={selected} onChange={pickAll}>
              <Stack gap={6} mt={4}>
                {field.options.map((o) => (
                  <Checkbox key={o} value={o} label={o} disabled={disabled} />
                ))}
                <Checkbox value={OTHER} label="Other" disabled={disabled} />
              </Stack>
            </Checkbox.Group>
          ) : (
            <MultiSelect
              {...common}
              data={[...field.options, { value: OTHER, label: "Other…" }]}
              value={selected}
              onChange={pickAll}
            />
          )}
          {otherBox(value.other)}
        </Stack>
      );
    }

    case "number":
      return (
        <Stack gap={4}>
          {value.other ? (
            <TextInput
              {...common}
              placeholder="Your answer"
              value={value.text}
              onChange={(e) => onChange({ text: e.currentTarget.value })}
            />
          ) : (
            <NumberInput
              {...common}
              value={value.num}
              {...(field.minimum !== undefined ? { min: field.minimum } : {})}
              {...(field.maximum !== undefined ? { max: field.maximum } : {})}
              allowDecimal={!field.integer}
              onChange={(num) =>
                onChange({ num: typeof num === "bigint" ? Number(num) : num })
              }
            />
          )}
          <Checkbox
            size="xs"
            label="Other"
            checked={value.other}
            disabled={disabled}
            onChange={(e) => onChange({ other: e.currentTarget.checked })}
          />
        </Stack>
      );

    case "boolean":
      return (
        <Stack gap={4}>
          <Radio.Group
            {...common}
            value={value.pick}
            onChange={(pick) => onChange({ pick })}
          >
            <Group gap="md" mt={4}>
              <Radio value="yes" label="Yes" disabled={disabled} />
              <Radio value="no" label="No" disabled={disabled} />
              <Radio value={OTHER} label="Other" disabled={disabled} />
            </Group>
          </Radio.Group>
          {otherBox(value.pick === OTHER)}
        </Stack>
      );
  }
}
