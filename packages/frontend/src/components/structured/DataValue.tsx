import { Paper, Stack, Text } from "@mantine/core";
import utils from "../../styles/utilities.module.css";
import {
  optionLabel,
  readSchemaForm,
  type FormField,
  type SchemaNode,
} from "@harness/core";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function Empty() {
  return (
    <Text span size="sm" c="dimmed">
      (empty)
    </Text>
  );
}

function scalarText(field: FormField, value: unknown): string {
  switch (field.kind) {
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "choice":
      return optionLabel(field, String(value));
    case "multi":
      return Array.isArray(value)
        ? value.map((v) => optionLabel(field, String(v))).join(", ")
        : String(value);
    case "text":
    case "number":
      return String(value);
    default:
      return JSON.stringify(value);
  }
}

function FieldValue({ field, value }: { field: FormField; value: unknown }) {
  const label = (
    <Text size="xs" c="dimmed">
      {field.label}
    </Text>
  );
  if (value === undefined) {
    return (
      <Stack gap={2}>
        {label}
        <Empty />
      </Stack>
    );
  }
  if (field.kind === "object") {
    const v = isObject(value) ? value : {};
    return (
      <Stack gap={4}>
        {label}
        <Paper p="xs">
          <Stack gap="xs">
            {field.fields.map((f) => (
              <FieldValue key={f.name} field={f} value={v[f.name]} />
            ))}
          </Stack>
        </Paper>
      </Stack>
    );
  }
  if (field.kind === "list") {
    const items = Array.isArray(value) ? value : [];
    return (
      <Stack gap={4}>
        {label}
        {items.length === 0 ? (
          <Empty />
        ) : (
          items.map((item, i) => (
            <Paper key={i} p="xs">
              <FieldValue
                field={{ ...field.item, label: `${i + 1}` }}
                value={item}
              />
            </Paper>
          ))
        )}
      </Stack>
    );
  }
  const text = scalarText(field, value);
  return (
    <Stack gap={2}>
      {label}
      {text === "" ? (
        <Empty />
      ) : (
        <Text size="sm" className={`${utils.preWrap} ${utils.breakWord}`}>
          {text}
        </Text>
      )}
    </Stack>
  );
}

export function DataValue({
  schema,
  value,
}: {
  schema: unknown;
  value: unknown;
}) {
  const form = readSchemaForm(schema as SchemaNode);
  const values: Record<string, unknown> = form.scalar
    ? { value }
    : isObject(value)
      ? value
      : {};
  return (
    <Paper p="sm">
      <Stack gap="sm">
        {form.fields.map((f) => (
          <FieldValue key={f.name} field={f} value={values[f.name]} />
        ))}
      </Stack>
    </Paper>
  );
}
