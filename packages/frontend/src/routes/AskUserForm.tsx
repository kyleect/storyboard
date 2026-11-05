import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Fieldset,
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
  optionLabel,
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
 *
 * Also draws forms other tools show (tool prompts design): those can label
 * their options, leave out "Other" (a yes/no without "Other" is a
 * checkbox) and name their buttons (D4 to D6, D8).
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
  /** A group: its fields' inputs, by name. */
  fields?: Record<string, FieldState>;
  /** A list: each item's inputs. */
  items?: FieldState[];
}

const EMPTY: FieldState = {
  text: "",
  pick: null,
  picks: [],
  num: "",
  other: false,
};

type TextFormat = Extract<FormField, { kind: "text" }>["format"];

/** The browser's offset from UTC now, as "+hh:mm" (for a `time`). */
export function localOffset(date = new Date()): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * A stored value as the browser's input shows it. JSON Schema times and
 * date-times carry a timezone (decision 17); the inputs show local time.
 */
export function toInput(format: TextFormat, value: string): string {
  if (value === "") return value;
  if (format === "date-time") {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  if (format === "time") return value.slice(0, 5);
  return value;
}

/**
 * What an input holds as a stored value: a date-time in UTC ("…Z"), a time
 * with the browser's current offset.
 */
export function fromInput(format: TextFormat, value: string): string {
  if (format === "date-time") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (format === "time" && /^\d{2}:\d{2}$/.test(value)) {
    return `${value}:00${localOffset()}`;
  }
  return value;
}

/** A question's inputs from its answer, or its default. */
export function initialState(field: FormField, answer?: unknown): FieldState {
  const given = answer !== undefined;
  switch (field.kind) {
    case "object": {
      const value =
        answer && typeof answer === "object" && !Array.isArray(answer)
          ? (answer as Record<string, unknown>)
          : {};
      return {
        ...EMPTY,
        fields: Object.fromEntries(
          field.fields.map((f) => [f.name, initialState(f, value[f.name])]),
        ),
      };
    }
    case "list": {
      const values = Array.isArray(answer) ? answer : [];
      return {
        ...EMPTY,
        items: values.map((v) => initialState(field.item, v)),
      };
    }
    case "text": {
      const text =
        typeof answer === "string"
          ? answer
          : given
            ? ""
            : (field.default ?? "");
      return { ...EMPTY, text: toInput(field.format, text) };
    }
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
      // A checkbox is always answered: unticked is "no".
      if (field.noOther)
        return { ...EMPTY, pick: value === true ? "yes" : "no" };
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
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of field.fields) {
        const a = answerOf(f, s.fields?.[f.name] ?? EMPTY);
        if (a !== undefined) out[f.name] = a;
      }
      // An optional group with nothing in it is left out.
      return Object.keys(out).length === 0 && !field.required ? undefined : out;
    }
    case "list": {
      const items = s.items ?? [];
      if (items.length === 0 && !field.required) return undefined;
      return items.map((i) => answerOf(field.item, i));
    }
    case "text":
      return s.text.trim() === "" ? undefined : fromInput(field.format, s.text);
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
      if (field.noOther) return s.pick === "yes";
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
  extraErrors,
  initial,
  heading = true,
}: {
  form: Form;
  state: AskUserState;
  /**
   * Problems found elsewhere, such as the backend's checks on save, by the
   * path of the question ("inventory.0.item").
   */
  extraErrors?: Record<string, string>;
  /** What an open form starts from, such as the data being edited. */
  initial?: Answers;
  /**
   * False: no heading row (no title, no badge), for forms whose page already
   * says what they are, such as a data form.
   */
  heading?: boolean;
}) {
  const open = state.mode === "open";
  const answers =
    state.mode === "answered" ? state.answers : open ? (initial ?? {}) : {};
  const [values, setValues] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [f.name, initialState(f, answers[f.name])]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>(
    extraErrors ?? {},
  );
  // New problems from elsewhere replace those shown (React's pattern for
  // state that follows a prop).
  const [shownExtra, setShownExtra] = useState(extraErrors);
  if (extraErrors !== shownExtra) {
    setShownExtra(extraErrors);
    if (extraErrors) setErrors(extraErrors);
  }
  const ref = useRef<HTMLDivElement>(null);
  const requestId = open ? state.requestId : null;

  // A form that opens is scrolled into view (D9).
  useEffect(() => {
    if (requestId) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [requestId]);

  const set = (name: string, change: Partial<FieldState>) => {
    setValues((v) => ({ ...v, [name]: { ...(v[name] ?? EMPTY), ...change } }));
    // A change clears the question's problems, and those inside it.
    setErrors((e) =>
      Object.fromEntries(
        Object.entries(e).filter(
          ([k]) => k !== name && !k.startsWith(`${name}.`),
        ),
      ),
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
          {heading && (
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
          )}
          {form.description && (
            <Text size="sm" c="dimmed">
              {form.description}
            </Text>
          )}
          {form.fields.map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              path={f.name}
              value={values[f.name] ?? EMPTY}
              errors={errors}
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
                {form.skipLabel ?? "Skip"}
              </Button>
              <Button type="submit" loading={state.busy}>
                {form.submitLabel ?? "Submit"}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Paper>
  );
}

/** The browser input for a text `format` (decision 17). */
const INPUT_TYPE = {
  date: "date",
  "date-time": "datetime-local",
  time: "time",
  email: "email",
  uri: "url",
} as const;

function FieldInput({
  field,
  path,
  value,
  errors,
  disabled,
  onChange,
}: {
  field: FormField;
  /** The question's path, for its problems ("inventory.0.item"). */
  path: string;
  value: FieldState;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (change: Partial<FieldState>) => void;
}) {
  const error = errors[path];
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
    case "object": {
      const fields = value.fields ?? {};
      return (
        <Fieldset
          legend={
            <Text size="sm" fw={500}>
              {field.label}
              {field.required ? " *" : ""}
            </Text>
          }
          disabled={disabled}
        >
          <Stack gap="sm">
            {field.help && (
              <Text size="xs" c="dimmed">
                {field.help}
              </Text>
            )}
            {field.fields.map((f) => (
              <FieldInput
                key={f.name}
                field={f}
                path={`${path}.${f.name}`}
                value={fields[f.name] ?? EMPTY}
                errors={errors}
                disabled={disabled}
                onChange={(change) =>
                  onChange({
                    fields: {
                      ...fields,
                      [f.name]: { ...(fields[f.name] ?? EMPTY), ...change },
                    },
                  })
                }
              />
            ))}
            {error && (
              <Text size="xs" c="red">
                {error}
              </Text>
            )}
          </Stack>
        </Fieldset>
      );
    }

    case "list": {
      const items = value.items ?? [];
      const full =
        field.maxItems !== undefined && items.length >= field.maxItems;
      const setItems = (next: FieldState[]) => onChange({ items: next });
      return (
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            {field.label}
            {field.required ? " *" : ""}
          </Text>
          {field.help && (
            <Text size="xs" c="dimmed">
              {field.help}
            </Text>
          )}
          {items.map((item, i) => (
            <Group key={i} align="flex-start" wrap="nowrap" gap="xs">
              <div style={{ flex: 1, minWidth: 0 }}>
                <FieldInput
                  field={{ ...field.item, label: `${field.label} ${i + 1}` }}
                  path={`${path}.${i}`}
                  value={item}
                  errors={errors}
                  disabled={disabled}
                  onChange={(change) =>
                    setItems(
                      items.map((it, j) =>
                        j === i ? { ...it, ...change } : it,
                      ),
                    )
                  }
                />
              </div>
              {!disabled && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  mt={4}
                  aria-label={`Remove ${field.label} ${i + 1}`}
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                >
                  ×
                </ActionIcon>
              )}
            </Group>
          ))}
          {!disabled && (
            <Group>
              <Button
                size="xs"
                variant="light"
                disabled={full}
                onClick={() => setItems([...items, initialState(field.item)])}
              >
                Add {field.label}
              </Button>
            </Group>
          )}
          {error && (
            <Text size="xs" c="red">
              {error}
            </Text>
          )}
        </Stack>
      );
    }

    case "text":
      if (field.format) {
        return (
          <TextInput
            {...common}
            type={INPUT_TYPE[field.format]}
            value={value.text}
            onChange={(e) => onChange({ text: e.currentTarget.value })}
          />
        );
      }
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
                  <Radio
                    key={o}
                    value={o}
                    label={optionLabel(field, o)}
                    disabled={disabled}
                  />
                ))}
                {!field.noOther && (
                  <Radio value={OTHER} label="Other" disabled={disabled} />
                )}
              </Stack>
            </Radio.Group>
          ) : (
            <Select
              {...common}
              data={selectData(field)}
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
                  <Checkbox
                    key={o}
                    value={o}
                    label={optionLabel(field, o)}
                    disabled={disabled}
                  />
                ))}
                {!field.noOther && (
                  <Checkbox value={OTHER} label="Other" disabled={disabled} />
                )}
              </Stack>
            </Checkbox.Group>
          ) : (
            <MultiSelect
              {...common}
              data={selectData(field)}
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
          {!field.noOther && (
            <Checkbox
              size="xs"
              label="Other"
              checked={value.other}
              disabled={disabled}
              onChange={(e) => onChange({ other: e.currentTarget.checked })}
            />
          )}
        </Stack>
      );

    case "boolean":
      if (field.noOther) {
        return (
          <Checkbox
            label={field.label}
            description={field.help}
            error={error}
            disabled={disabled}
            checked={value.pick === "yes"}
            onChange={(e) =>
              onChange({ pick: e.currentTarget.checked ? "yes" : "no" })
            }
          />
        );
      }
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

/** Dropdown items: each option with its label, then "Other…" if offered. */
function selectData(field: Extract<FormField, { kind: "choice" | "multi" }>) {
  return [
    ...field.options.map((o) => ({ value: o, label: optionLabel(field, o) })),
    ...(field.noOther ? [] : [{ value: OTHER, label: "Other…" }]),
  ];
}
