import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  NavLink,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  applyDefaults,
  checkAnswers,
  MAX_DATA_DESCRIPTION,
  MAX_DATA_NAME,
  readSchemaForm,
  schemaFormAnswers,
  schemaFormValue,
  type Answers,
  type Form,
  type SchemaInfo,
  type SchemaNode,
} from "@harness/core";
import {
  api,
  type DataDetail,
  type DataItem,
  type DataOwner,
  type DataVersion,
} from "../api";
import { dataKeys, schemaKeys } from "../queries";
import { AskUserForm } from "./AskUserForm";
import { DataValue } from "./DataValue";
import { showError } from "./SessionActions";

/*
 * Data (schemas and data design, decisions 19 to 25, 44): a panel per scope
 * with the list on the left and the selected piece of data on the right, as
 * for skills. The global and project "Structured Data" pages, the agent's
 * page and the session's Data tab use it. Forms are made from the schema
 * (decisions 19, 20); the backend's checks have the final word on save
 * (plan P3), and their problems show next to the fields.
 */

export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

function useRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: dataKeys.all });
  };
}

/** The form for a schema version, titled for what is being done. */
export const formOf = (body: unknown, submitLabel: string): Form => ({
  ...readSchemaForm(body as SchemaNode),
  submitLabel,
  skipLabel: "Cancel",
});

/**
 * The backend's problems as form problems, by question path: "/inv/0/item"
 * becomes "inv.0.item"; a missing property is shown on that property. A
 * scalar form's one question is "value". Undefined when there are none.
 */
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
      {d.deleted && (
        <Badge size="xs" variant="light" color="red">
          deleted
        </Badge>
      )}
      {d.outOfDate && (
        <Badge size="xs" variant="light" color="yellow">
          out of date
        </Badge>
      )}
      {!d.schemaInScope && (
        <Badge size="xs" variant="light" color="gray">
          schema not available
        </Badge>
      )}
    </>
  );
}

type Mode =
  | { mode: "view" }
  | { mode: "new"; schemaId: string | null }
  | { mode: "edit" }
  | { mode: "migrate" };

/**
 * An owner's data. `readOnly` with a reason when changes are not allowed;
 * the backend also says so for its own reasons (a project in the trash).
 */
export function DataPanel({
  owner,
  readOnly,
}: {
  owner: DataOwner;
  readOnly?: string | undefined;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ mode: "view" });
  const list = useQuery({
    queryKey: dataKeys.list(owner, showDeleted),
    queryFn: () => api.listData(owner, showDeleted),
  });
  const schemas = useQuery({
    queryKey: dataKeys.schemaInfos(owner),
    queryFn: () => api.dataSchemas(owner),
  });
  const names = new Map((schemas.data ?? []).map((s) => [s.id, s.name]));
  const locked =
    readOnly ??
    (list.data?.readOnly
      ? `${list.data.readOnly} Its data can be read but not changed.`
      : undefined);
  const narrow = owner.scope === "agent" || owner.scope === "session";

  return (
    <Group align="flex-start" wrap="nowrap" gap="md">
      <Stack gap="xs" w={narrow ? 200 : 260} style={{ flexShrink: 0 }}>
        {locked && (
          <Text size="sm" c="dimmed">
            {locked}
          </Text>
        )}
        <Switch
          size="xs"
          label="Show deleted"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.currentTarget.checked)}
        />
        {!locked && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              disabled={(schemas.data ?? []).length === 0}
              onClick={() => {
                setSelected(null);
                setMode({ mode: "new", schemaId: null });
              }}
            >
              New data
            </Button>
          </Group>
        )}
        {schemas.data?.length === 0 && !locked && (
          <Text size="xs" c="dimmed">
            No schema here can make data yet.
          </Text>
        )}
        {list.isPending && <Loader size="sm" />}
        {list.isError && <Alert color="red">{list.error.message}</Alert>}
        {list.data?.data.length === 0 && (
          <Text size="sm" c="dimmed">
            No data.
          </Text>
        )}
        <Stack gap={0}>
          {list.data?.data.map((d) => (
            <NavLink
              key={d.id}
              active={selected === d.id && mode.mode !== "new"}
              onClick={() => {
                setSelected(d.id);
                setMode({ mode: "view" });
              }}
              label={
                <Text
                  size="sm"
                  truncate
                  {...(d.deleted ? { c: "dimmed" } : {})}
                >
                  {d.name}
                </Text>
              }
              description={`${names.get(d.schemaId) ?? "Unknown schema"} · v${d.schemaVersion}`}
              rightSection={<Badges d={d} />}
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {mode.mode === "new" && !locked ? (
          <NewData
            owner={owner}
            schemas={schemas.data ?? []}
            onSaved={(id) => {
              setSelected(id);
              setMode({ mode: "view" });
            }}
            onCancel={() => setMode({ mode: "view" })}
          />
        ) : selected ? (
          <DataItemView
            key={selected}
            owner={owner}
            dataId={selected}
            readOnly={!!locked}
            mode={mode}
            setMode={setMode}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            Pick a piece of data on the left.
          </Text>
        )}
      </Stack>
    </Group>
  );
}

/** Pick a schema, then fill in its form. */
function NewData({
  owner,
  schemas,
  onSaved,
  onCancel,
}: {
  owner: DataOwner;
  schemas: SchemaInfo[];
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [schemaId, setSchemaId] = useState<string | null>(
    schemas.length === 1 ? (schemas[0]?.id ?? null) : null,
  );
  const schema = schemas.find((s) => s.id === schemaId);
  return (
    <Stack gap="xs">
      <Select
        label="Schema"
        description="What kind of data to make."
        placeholder="Pick a schema"
        data={schemas.map((s) => ({
          value: s.id,
          label: `${s.name} (${s.scope})`,
        }))}
        value={schemaId}
        onChange={setSchemaId}
      />
      {schema && (
        <NewDataForm
          key={schema.id}
          owner={owner}
          schema={schema}
          onSaved={onSaved}
          onCancel={onCancel}
        />
      )}
      {!schema && (
        <Group>
          <Button size="xs" variant="default" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function NewDataForm({
  owner,
  schema,
  onSaved,
  onCancel,
}: {
  owner: DataOwner;
  schema: SchemaInfo;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const body = useQuery({
    queryKey: schemaKeys.latest(schema.id),
    queryFn: () => api.schemaBody(owner, schema.id),
  });
  if (body.isPending) return <Loader size="sm" />;
  if (body.isError) return <Alert color="red">{body.error.message}</Alert>;
  return (
    <DataEditor
      body={body.data}
      submitLabel="Create"
      initialName=""
      initialDescription=""
      initialValue={undefined}
      save={(c) => api.createData(owner, schema.id, c)}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

/**
 * A name, a description and the schema's form. `checkFirst` marks the
 * problems of the starting value at once (a migration, decision 21).
 */
function DataEditor({
  body,
  submitLabel,
  initialName,
  initialDescription,
  initialValue,
  checkFirst,
  note,
  save,
  onSaved,
  onCancel,
}: {
  body: unknown;
  submitLabel: string;
  initialName: string;
  initialDescription: string;
  initialValue: unknown;
  checkFirst?: boolean;
  note?: string;
  save: (c: {
    name: string;
    description: string;
    value: unknown;
  }) => Promise<{ id: string }>;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh();
  const form = useMemo(() => formOf(body, submitLabel), [body, submitLabel]);
  const initial = useMemo(
    () => schemaFormAnswers(form, initialValue),
    [form, initialValue],
  );
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [problems, setProblems] = useState<Record<string, string> | undefined>(
    () => {
      if (!checkFirst) return undefined;
      const checked = checkAnswers(form, initial);
      return checked.ok ? undefined : checked.errors;
    },
  );
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (answers: Answers) =>
      save({ name, description, value: schemaFormValue(form, answers) }),
    onSuccess: async (saved) => {
      await refresh();
      onSaved(saved.id);
    },
    onError: (err: Error) => {
      const mapped = errorsFromMessage(form, err.message);
      setProblems(mapped);
      setError(mapped ? null : err.message);
    },
  });
  const blank = name.trim() === "" || description.trim() === "";

  return (
    <Stack gap="xs">
      {note && (
        <Text size="sm" c="dimmed">
          {note}
        </Text>
      )}
      <TextInput
        label="Name"
        withAsterisk
        maxLength={MAX_DATA_NAME}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <Textarea
        label="Description"
        description="What this piece of data is, for you and the agent."
        withAsterisk
        autosize
        minRows={2}
        maxRows={6}
        maxLength={MAX_DATA_DESCRIPTION}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      {error && (
        <Alert color="red" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </Alert>
      )}
      <AskUserForm
        form={form}
        heading={false}
        initial={initial}
        {...(problems ? { extraErrors: problems } : {})}
        state={{
          mode: "open",
          requestId: "data-form",
          busy: submit.isPending,
          onAnswer: (answer) => {
            if (answer.outcome === "skipped") onCancel();
            else if (blank) setError("Give a name and a description to save.");
            else submit.mutate(answer.answers);
          },
        }}
      />
    </Stack>
  );
}

function DataItemView({
  owner,
  dataId,
  readOnly,
  mode,
  setMode,
  onGone,
}: {
  owner: DataOwner;
  dataId: string;
  readOnly: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  onGone: () => void;
}) {
  const refresh = useRefresh();
  const [versions, setVersions] = useState(false);
  const item = useQuery({
    queryKey: dataKeys.detail(owner, dataId),
    queryFn: () => api.getData(owner, dataId),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteData(owner, dataId),
    onSuccess: refresh,
    onError: showError("Could not delete the data"),
  });

  if (item.isPending) return <Loader size="sm" />;
  if (item.isError) {
    return (
      <Alert color="red" withCloseButton onClose={onGone}>
        {item.error.message}
      </Alert>
    );
  }
  const d = item.data;
  const changeable = !readOnly && !d.deleted && d.schema !== null;
  const view = () => setMode({ mode: "view" });

  if (mode.mode === "edit" && changeable && d.schema) {
    return (
      <DataEditor
        body={d.schema.pinned}
        submitLabel="Save"
        initialName={d.name}
        initialDescription={d.description}
        initialValue={d.value}
        save={(c) => api.saveData(owner, d.id, c)}
        onSaved={view}
        onCancel={view}
      />
    );
  }
  if (mode.mode === "migrate" && changeable && d.schema && d.outOfDate) {
    const latest = d.schema.latest as SchemaNode;
    return (
      <DataEditor
        body={latest}
        submitLabel={`Migrate to v${d.latestVersion}`}
        initialName={d.name}
        initialDescription={d.description}
        initialValue={applyDefaults(latest, d.value)}
        checkFirst
        note={`Version ${d.latestVersion} of ${d.schema.name} is filled in from this data and the schema's defaults. Fix the marked fields, then migrate.`}
        save={(c) =>
          api.migrateData(owner, d.id, c.value).then((r) => ({ id: r.id }))
        }
        onSaved={view}
        onCancel={view}
      />
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={5} style={{ wordBreak: "break-word" }}>
            {d.name}
          </Title>
          <Badges d={d} />
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setVersions(true)}>
            Versions ({d.versions.length})
          </Button>
          {changeable && d.outOfDate && (
            <Button
              size="xs"
              color="yellow"
              variant="light"
              onClick={() => setMode({ mode: "migrate" })}
            >
              Migrate to v{d.latestVersion}
            </Button>
          )}
          {changeable && (
            <Button
              size="xs"
              variant="light"
              onClick={() => setMode({ mode: "edit" })}
            >
              Edit
            </Button>
          )}
          {!readOnly && !d.deleted && (
            <Button
              size="xs"
              variant="light"
              color="red"
              loading={remove.isPending}
              onClick={() =>
                modals.openConfirmModal({
                  title: `Delete “${d.name}”?`,
                  children: (
                    <Text size="sm">
                      The agent can no longer use it. Its versions are kept, and
                      it can be restored from them.
                    </Text>
                  ),
                  labels: { confirm: "Delete", cancel: "Cancel" },
                  confirmProps: { color: "red" },
                  onConfirm: () => remove.mutate(),
                })
              }
            >
              Delete
            </Button>
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {d.schema
          ? `${d.schema.name} (${d.schema.scope}), version ${d.schemaVersion}`
          : "Its schema is not available here, so it can be viewed and deleted, not changed."}
        {d.outOfDate &&
          ` · out of date: the schema is at version ${d.latestVersion}`}
        {d.deleted && " · deleted. Open Versions to restore it."}
      </Text>
      {d.outOfDate && d.latestErrors.length > 0 && (
        <Alert color="yellow" title="Against the latest version">
          {d.latestErrors.map((e) => (
            <Text key={e} size="xs">
              {e}
            </Text>
          ))}
        </Alert>
      )}
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {d.description}
      </Text>
      {d.schema ? (
        <DataValue schema={d.schema.pinned} value={d.value} />
      ) : (
        <Code block>{JSON.stringify(d.value, null, 2)}</Code>
      )}
      {versions && (
        <VersionsModal
          owner={owner}
          item={d}
          readOnly={readOnly}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

/** A piece of data's saved states; one can be made current (decision 24). */
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
  const newestFirst = [...item.versions].reverse();
  const [picked, setPicked] = useState<DataVersion | undefined>(newestFirst[0]);
  const restore = useMutation({
    mutationFn: (seq: number) => api.restoreData(owner, item.id, seq),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const latest = newestFirst[0];
  const isCurrent = picked?.seq === latest?.seq && !item.deleted;

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${item.name}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={220} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={
                <Group gap={4}>
                  <Text size="sm">#{v.seq}</Text>
                  <Badge size="xs" variant="light" color="gray">
                    {v.author}
                  </Badge>
                  {v.deleted && (
                    <Badge size="xs" variant="light" color="red">
                      deleted
                    </Badge>
                  )}
                </Group>
              }
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {picked.deleted
                  ? "Deleted here; the content it had is shown."
                  : `On schema version ${picked.schemaVersion}.`}
              </Text>
              {!readOnly && item.schema && (
                <Button
                  size="xs"
                  disabled={picked.deleted || isCurrent}
                  loading={restore.isPending}
                  onClick={() => restore.mutate(picked.seq)}
                >
                  {isCurrent ? "Current" : "Make current"}
                </Button>
              )}
            </Group>
            <Text size="sm" fw={500}>
              {picked.name}
            </Text>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {picked.description}
            </Text>
            <ScrollArea.Autosize mah="50vh">
              <Code block>{JSON.stringify(picked.value, null, 2)}</Code>
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}
