import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NavLink,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import {
  MAX_DATA_DESCRIPTION,
  MAX_DATA_NAME,
  SCHEMA_FORMATS,
} from "@harness/core";
import {
  api,
  dataKey,
  type CopyTarget,
  type DataOwner,
  type SchemaDetail,
} from "../api";
import {
  addField,
  changeType,
  checkTree,
  FIELD_TYPES,
  findNode,
  flatten,
  fromSchema,
  moveField,
  newNode,
  removeField,
  toSchema,
  updateNode,
  type BuilderNode,
  type FieldType,
  type TextFormat,
} from "../schema-builder";
import { JsonEditor } from "./JsonEditor";
import { showError } from "./SessionActions";

/*
 * Schemas (schemas and data design, decisions 8 to 15, 44): a panel per
 * scope with the list on the left and the selected schema on the right, as
 * for skills and data. The editor is a builder (plan P10, layout A: a field
 * tree on the left, the selected field's settings on the right) or a JSON
 * editor, switchable (decision 15). Earlier versions can be viewed.
 */

/** Schemas share the ["data", …] keys, so a change refreshes both. */
const schemasKey = (o: DataOwner) => [...dataKey(o), "schemas-panel"];

function useRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ["data"] });
  };
}

const typeLabel = (t: FieldType) =>
  FIELD_TYPES.find((f) => f.value === t)?.label ?? t;

export function SchemasPanel({
  owner,
  readOnly,
}: {
  owner: DataOwner;
  readOnly?: string | undefined;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "new">("view");
  const list = useQuery({
    queryKey: [...schemasKey(owner), "list", showDeleted],
    queryFn: () => api.listSchemas(owner, showDeleted),
  });
  const locked =
    readOnly ??
    (list.data?.readOnly
      ? `${list.data.readOnly} Its schemas can be read but not changed.`
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
              onClick={() => {
                setSelected(null);
                setMode("new");
              }}
            >
              New schema
            </Button>
          </Group>
        )}
        {list.isPending && <Loader size="sm" />}
        {list.isError && <Alert color="red">{list.error.message}</Alert>}
        {list.data?.schemas.length === 0 && (
          <Text size="sm" c="dimmed">
            No schemas.
          </Text>
        )}
        <Stack gap={0}>
          {list.data?.schemas.map((s) => (
            <NavLink
              key={s.id}
              active={selected === s.id && mode !== "new"}
              onClick={() => {
                setSelected(s.id);
                setMode("view");
              }}
              label={
                <Text
                  size="sm"
                  truncate
                  {...(s.deleted ? { c: "dimmed" } : {})}
                >
                  {s.name}
                </Text>
              }
              description={`v${s.version}`}
              rightSection={
                s.deleted ? (
                  <Badge size="xs" variant="light" color="red">
                    deleted
                  </Badge>
                ) : undefined
              }
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {mode === "new" && !locked ? (
          <SchemaEditor
            owner={owner}
            onSaved={(id) => {
              setSelected(id);
              setMode("view");
            }}
            onCancel={() => setMode("view")}
          />
        ) : selected ? (
          <SchemaView
            key={selected}
            owner={owner}
            schemaId={selected}
            readOnly={!!locked}
            editing={mode === "edit"}
            onEdit={() => setMode("edit")}
            onDone={() => setMode("view")}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            Pick a schema on the left.
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function SchemaView({
  owner,
  schemaId,
  readOnly,
  editing,
  onEdit,
  onDone,
  onGone,
}: {
  owner: DataOwner;
  schemaId: string;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
}) {
  const refresh = useRefresh();
  const [versions, setVersions] = useState(false);
  const [copying, setCopying] = useState(false);
  const schema = useQuery({
    queryKey: [...schemasKey(owner), "one", schemaId],
    queryFn: () => api.getSchema(owner, schemaId),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchema(owner, schemaId),
    onSuccess: refresh,
    onError: showError("Could not delete the schema"),
  });
  const restore = useMutation({
    mutationFn: () => api.restoreSchema(owner, schemaId),
    onSuccess: refresh,
    onError: showError("Could not restore the schema"),
  });

  if (schema.isPending) return <Loader size="sm" />;
  if (schema.isError) {
    return (
      <Alert color="red" withCloseButton onClose={onGone}>
        {schema.error.message}
      </Alert>
    );
  }
  const s = schema.data;
  if (editing && !readOnly && !s.deleted) {
    return (
      <SchemaEditor
        owner={owner}
        existing={s}
        onSaved={onDone}
        onCancel={onDone}
      />
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={5} style={{ wordBreak: "break-word" }}>
            {s.name}
          </Title>
          <Badge size="xs" variant="light" color="gray">
            v{s.version}
          </Badge>
          {s.deleted && (
            <Badge size="xs" variant="light" color="red">
              deleted
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setVersions(true)}>
            Versions ({s.versions.length})
          </Button>
          {!s.deleted && (
            <Button
              size="xs"
              variant="default"
              onClick={() => setCopying(true)}
            >
              Copy…
            </Button>
          )}
          {!readOnly && !s.deleted && (
            <>
              <Button size="xs" variant="light" onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                loading={remove.isPending}
                onClick={() =>
                  modals.openConfirmModal({
                    title: `Delete “${s.name}”?`,
                    children: (
                      <Text size="sm">
                        {s.dataCount === 0
                          ? "No data is made from it."
                          : `Its ${s.dataCount === 1 ? "piece" : `${s.dataCount} pieces`} of data ${s.dataCount === 1 ? "is" : "are"} deleted with it.`}{" "}
                        Restoring the schema brings{" "}
                        {s.dataCount === 0 ? "it" : "them"} back.
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
            </>
          )}
          {!readOnly && s.deleted && (
            <Button
              size="xs"
              loading={restore.isPending}
              onClick={() => restore.mutate()}
            >
              Restore
            </Button>
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {s.scope}
        {s.deleted
          ? " · deleted, with its data"
          : ` · ${s.dataCount} ${s.dataCount === 1 ? "piece" : "pieces"} of data`}
        {s.copiedFrom && " · copied from another schema"}
      </Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {s.description}
      </Text>
      <Code block>{JSON.stringify(s.body, null, 2)}</Code>
      {versions && (
        <VersionsModal schema={s} onClose={() => setVersions(false)} />
      )}
      {copying && (
        <CopyModal owner={owner} schema={s} onClose={() => setCopying(false)} />
      )}
    </Stack>
  );
}

/** Every version's JSON Schema, view only. */
function VersionsModal({
  schema,
  onClose,
}: {
  schema: SchemaDetail;
  onClose: () => void;
}) {
  const newestFirst = [...schema.versions].reverse();
  const [picked, setPicked] = useState(newestFirst[0]);
  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${schema.name}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={160} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.version}
              active={picked?.version === v.version}
              onClick={() => setPicked(v)}
              label={`v${v.version}${v.version === schema.version ? " (latest)" : ""}`}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <ScrollArea.Autosize mah="60vh" style={{ flex: 1, minWidth: 0 }}>
            <Code block>{JSON.stringify(picked.body, null, 2)}</Code>
          </ScrollArea.Autosize>
        )}
      </Group>
    </Modal>
  );
}

/** Copies the latest version to global, a project or an agent (decision 12). */
function CopyModal({
  owner,
  schema,
  onClose,
}: {
  owner: DataOwner;
  schema: SchemaDetail;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const globalAgents = useQuery({
    queryKey: ["agents", "global", null, "copy-targets"],
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const projectAgents = useQueries({
    queries: (projects.data ?? []).map((p) => ({
      queryKey: ["agents", "project", p.id, "copy-targets"],
      queryFn: () => api.listAgents({ scope: "project", id: p.id }, false),
    })),
  });
  const [target, setTarget] = useState<string | null>(null);
  const [name, setName] = useState(schema.name);
  const copy = useMutation({
    mutationFn: () => {
      const [scope, id = ""] = (target ?? "").split(":");
      const to: CopyTarget =
        scope === "global"
          ? { scope: "global" }
          : scope === "project"
            ? { scope: "project", id }
            : { scope: "agent", id };
      return api.copySchema(owner, schema.id, to, name);
    },
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not copy the schema"),
  });
  const live = (projects.data ?? []).filter((p) => p.trashed_at === null);
  const options = [
    { group: "Global", items: [{ value: "global", label: "Global" }] },
    {
      group: "Projects",
      items: live.map((p) => ({ value: `project:${p.id}`, label: p.name })),
    },
    {
      group: "Agents",
      items: [
        ...(globalAgents.data ?? []).map((a) => ({
          value: `agent:${a.id}`,
          label: `${a.name} (global)`,
        })),
        ...projectAgents.flatMap((q, i) =>
          (q.data ?? []).map((a) => ({
            value: `agent:${a.id}`,
            label: `${a.name} (${live[i]?.name ?? "project"})`,
          })),
        ),
      ],
    },
  ].filter((g) => g.items.length > 0);

  return (
    <Modal opened onClose={onClose} title={`Copy ${schema.name}`}>
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          The copy is a new schema at version 1, made from version{" "}
          {schema.version}. Data made from this one stays with it.
        </Text>
        <Select
          label="Copy to"
          placeholder="Pick where"
          data={options}
          value={target}
          onChange={setTarget}
          searchable
        />
        <TextInput
          label="Name"
          description="Unique among the schemas where it goes."
          maxLength={MAX_DATA_NAME}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          <Button size="xs" variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            disabled={!target || name.trim() === ""}
            loading={copy.isPending}
            onClick={() => copy.mutate()}
          >
            Copy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---- The editor --------------------------------------------------------------

const EMPTY_SCHEMA = { type: "object", properties: {} };

/** Creates a schema, or saves `existing` (a new version if it changed). */
function SchemaEditor({
  owner,
  existing,
  onSaved,
  onCancel,
}: {
  owner: DataOwner;
  existing?: SchemaDetail;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh();
  const start = existing?.body ?? EMPTY_SCHEMA;
  const read = fromSchema(start);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [mode, setMode] = useState<"builder" | "json">(
    read.ok ? "builder" : "json",
  );
  const [root, setRoot] = useState<BuilderNode>(
    read.ok ? read.root : newNode("group"),
  );
  const [text, setText] = useState(JSON.stringify(start, null, 2));
  const [notice, setNotice] = useState<string | null>(
    read.ok ? null : `The builder can't show this schema:\n${read.reason}`,
  );
  const [error, setError] = useState<string | null>(null);
  const problems = mode === "builder" ? checkTree(root) : {};

  const switchTo = (next: "builder" | "json") => {
    if (next === mode) return;
    if (next === "json") {
      setText(JSON.stringify(toSchema(root), null, 2));
      setNotice(null);
      setMode("json");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setNotice(`The JSON can't be read: ${(err as Error).message}`);
      return;
    }
    const r = fromSchema(parsed);
    if (!r.ok) {
      setNotice(`The builder can't show this schema:\n${r.reason}`);
      return;
    }
    setRoot(r.root);
    setNotice(null);
    setMode("builder");
  };

  const save = useMutation({
    mutationFn: () => {
      let body: unknown;
      if (mode === "builder") body = toSchema(root);
      else {
        try {
          body = JSON.parse(text);
        } catch (err) {
          throw new Error(`The JSON can't be read: ${(err as Error).message}`, {
            cause: err,
          });
        }
      }
      const c = { name, description, body };
      return existing
        ? api.saveSchema(owner, existing.id, c)
        : api.createSchema(owner, c);
    },
    onSuccess: async (saved) => {
      await refresh();
      onSaved(saved.id);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Stack gap="xs">
      <TextInput
        label="Name"
        description="Unique among this scope's schemas."
        withAsterisk
        maxLength={MAX_DATA_NAME}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
      />
      <Textarea
        label="Description"
        description="What the schema is for. The agent reads this."
        withAsterisk
        autosize
        minRows={2}
        maxRows={6}
        maxLength={MAX_DATA_DESCRIPTION}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => switchTo(v as "builder" | "json")}
          data={[
            { value: "builder", label: "Builder" },
            { value: "json", label: "JSON" },
          ]}
        />
        {existing && (
          <Text size="xs" c="dimmed">
            Changing the fields saves version {existing.version + 1}; data that
            doesn't fit it is marked out of date.
          </Text>
        )}
      </Group>
      {notice && (
        <Alert color="yellow" style={{ whiteSpace: "pre-wrap" }}>
          {notice}
        </Alert>
      )}
      {mode === "builder" ? (
        <Builder root={root} onChange={setRoot} problems={problems} />
      ) : (
        <JsonEditor value={text} onChange={setText} label="JSON Schema" />
      )}
      {error && (
        <Alert color="red" style={{ whiteSpace: "pre-wrap" }}>
          {error}
        </Alert>
      )}
      <Group gap="xs">
        <Button
          size="xs"
          disabled={
            name.trim() === "" ||
            description.trim() === "" ||
            Object.keys(problems).length > 0
          }
          loading={save.isPending}
          onClick={() => {
            setError(null);
            save.mutate();
          }}
        >
          Save
        </Button>
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

/** Layout A: the field tree on the left, the selected field on the right. */
function Builder({
  root,
  onChange,
  problems,
}: {
  root: BuilderNode;
  onChange: (root: BuilderNode) => void;
  problems: Record<string, string>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const rows = flatten(root);
  const current = selected ? findNode(root, selected) : undefined;
  const single = root.type !== "group";
  const shown = single ? root : current;
  const row = rows.find((r) => r.node.id === selected);
  const add = (groupId: string) => {
    const node = newNode("text");
    onChange(addField(root, groupId, node));
    setSelected(node.id);
  };

  return (
    <Paper withBorder p="sm">
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Select
            size="xs"
            label="The data is"
            data={[
              { value: "group", label: "A group of fields" },
              ...FIELD_TYPES.filter((t) => t.value !== "group").map((t) => ({
                value: t.value,
                label: `One value: ${t.label.toLowerCase()}`,
              })),
            ]}
            value={root.type}
            onChange={(v) => {
              if (!v) return;
              onChange(changeType(root, v as FieldType));
              setSelected(null);
            }}
            allowDeselect={false}
          />
          {!single && (
            <>
              {rows.length === 0 && (
                <Text size="xs" c="dimmed">
                  No fields yet.
                </Text>
              )}
              {rows.map(({ node, depth, role }) => (
                <UnstyledButton
                  key={node.id}
                  onClick={() => setSelected(node.id)}
                  style={{
                    paddingLeft: 6 + depth * 16,
                    paddingBlock: 3,
                    paddingRight: 6,
                    borderRadius: 4,
                    background:
                      selected === node.id
                        ? "var(--mantine-color-default-hover)"
                        : undefined,
                  }}
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" ff="monospace" truncate>
                      {role === "item" ? "each item" : node.key || "(unnamed)"}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {typeLabel(node.type)}
                    </Badge>
                    {node.required && role === "field" && (
                      <Text size="xs" c="red">
                        required
                      </Text>
                    )}
                    {problems[node.id] && (
                      <Text size="xs" c="red">
                        !
                      </Text>
                    )}
                  </Group>
                </UnstyledButton>
              ))}
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => add(root.id)}
                >
                  + Add field
                </Button>
                {current?.type === "group" && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => add(current.id)}
                  >
                    + Add field inside {current.key || "this group"}
                  </Button>
                )}
              </Group>
            </>
          )}
        </Stack>
        <Stack gap="xs" style={{ flex: 1.3, minWidth: 0 }}>
          {shown ? (
            <FieldSettings
              key={shown.id}
              node={shown}
              role={single ? "root" : (row?.role ?? "field")}
              problem={problems[shown.id]}
              onChange={(n) => onChange(updateNode(root, shown.id, () => n))}
              onMove={
                single || row?.role !== "field"
                  ? undefined
                  : (by) => onChange(moveField(root, shown.id, by))
              }
              onRemove={
                single || row?.role !== "field"
                  ? undefined
                  : () => {
                      onChange(removeField(root, shown.id));
                      setSelected(null);
                    }
              }
            />
          ) : (
            <Text size="xs" c="dimmed">
              Pick a field to set it up, or add one.
            </Text>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}

const num = (v: string | number) =>
  typeof v === "number" ? v : v === "" ? undefined : Number(v);

/** The selected field's settings. */
function FieldSettings({
  node,
  role,
  problem,
  onChange,
  onMove,
  onRemove,
}: {
  node: BuilderNode;
  role: "root" | "field" | "item";
  problem: string | undefined;
  onChange: (n: BuilderNode) => void;
  onMove: ((by: -1 | 1) => void) | undefined;
  onRemove: (() => void) | undefined;
}) {
  const set = (change: Partial<BuilderNode>) =>
    onChange({ ...node, ...change });
  return (
    <Stack gap={6}>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {role === "item" ? "Each item of the list" : "Field settings"}
        </Text>
        <Group gap={2}>
          {onMove && (
            <>
              <ActionIcon
                size="sm"
                variant="subtle"
                aria-label="Move up"
                onClick={() => onMove(-1)}
              >
                ↑
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant="subtle"
                aria-label="Move down"
                onClick={() => onMove(1)}
              >
                ↓
              </ActionIcon>
            </>
          )}
          {onRemove && (
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              aria-label="Remove field"
              onClick={onRemove}
            >
              ×
            </ActionIcon>
          )}
        </Group>
      </Group>
      {problem && (
        <Text size="xs" c="red">
          {problem}
        </Text>
      )}
      {role === "field" && (
        <TextInput
          size="xs"
          label="Name"
          description="The key in the data."
          value={node.key}
          onChange={(e) => set({ key: e.currentTarget.value })}
        />
      )}
      {role !== "root" && (
        <Select
          size="xs"
          label="Type"
          data={FIELD_TYPES}
          value={node.type}
          allowDeselect={false}
          onChange={(v) => v && onChange(changeType(node, v as FieldType))}
        />
      )}
      <TextInput
        size="xs"
        label="Label"
        description="What a form shows; the name when empty."
        value={node.title}
        onChange={(e) => set({ title: e.currentTarget.value })}
      />
      <TextInput
        size="xs"
        label="Help"
        value={node.description}
        onChange={(e) => set({ description: e.currentTarget.value })}
      />
      {role === "field" && (
        <Checkbox
          size="xs"
          label="Required"
          checked={node.required}
          onChange={(e) => set({ required: e.currentTarget.checked })}
        />
      )}
      {node.type === "text" && (
        <>
          <Select
            size="xs"
            label="Format"
            data={[
              { value: "", label: "Any text" },
              ...SCHEMA_FORMATS.map((f) => ({ value: f, label: f })),
            ]}
            value={node.format}
            allowDeselect={false}
            onChange={(v) => set({ format: (v ?? "") as TextFormat })}
          />
          <Group grow>
            <NumberInput
              size="xs"
              label="Shortest"
              min={0}
              allowDecimal={false}
              value={node.minLength ?? ""}
              onChange={(v) => set({ minLength: num(v) })}
            />
            <NumberInput
              size="xs"
              label="Longest"
              min={0}
              allowDecimal={false}
              value={node.maxLength ?? ""}
              onChange={(v) => set({ maxLength: num(v) })}
            />
          </Group>
          <TextInput
            size="xs"
            label="Pattern"
            description="A regular expression the text must match."
            ff="monospace"
            value={node.pattern}
            onChange={(e) => set({ pattern: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            label="Default"
            value={typeof node.default === "string" ? node.default : ""}
            onChange={(e) => set({ default: e.currentTarget.value })}
          />
        </>
      )}
      {(node.type === "number" || node.type === "integer") && (
        <>
          <Group grow>
            <NumberInput
              size="xs"
              label="Lowest"
              allowDecimal={node.type === "number"}
              value={node.minimum ?? ""}
              onChange={(v) => set({ minimum: num(v) })}
            />
            <NumberInput
              size="xs"
              label="Highest"
              allowDecimal={node.type === "number"}
              value={node.maximum ?? ""}
              onChange={(v) => set({ maximum: num(v) })}
            />
          </Group>
          <NumberInput
            size="xs"
            label="Default"
            allowDecimal={node.type === "number"}
            value={typeof node.default === "number" ? node.default : ""}
            onChange={(v) => set({ default: num(v) })}
          />
        </>
      )}
      {node.type === "boolean" && (
        <Select
          size="xs"
          label="Default"
          data={[
            { value: "", label: "None" },
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
          value={
            node.default === true ? "yes" : node.default === false ? "no" : ""
          }
          allowDeselect={false}
          onChange={(v) =>
            set({
              default: v === "yes" ? true : v === "no" ? false : undefined,
            })
          }
        />
      )}
      {(node.type === "choice" || node.type === "multi") && (
        <>
          <TagsInput
            size="xs"
            label="Options"
            description="Press Enter after each."
            value={node.options}
            onChange={(options) => set({ options })}
          />
          {node.type === "choice" && (
            <>
              <Checkbox
                size="xs"
                label="The options are numbers"
                checked={node.numeric}
                onChange={(e) => set({ numeric: e.currentTarget.checked })}
              />
              <Select
                size="xs"
                label="Default"
                data={[
                  { value: "", label: "None" },
                  ...node.options.map((o) => ({ value: o, label: o })),
                ]}
                value={typeof node.default === "string" ? node.default : ""}
                allowDeselect={false}
                onChange={(v) => set({ default: v || undefined })}
              />
            </>
          )}
          {node.type === "multi" && (
            <MultiSelect
              size="xs"
              label="Default"
              data={node.options}
              value={
                Array.isArray(node.default) ? node.default.map(String) : []
              }
              onChange={(v) => set({ default: v })}
            />
          )}
        </>
      )}
      {(node.type === "list" || node.type === "multi") && (
        <Group grow>
          <NumberInput
            size="xs"
            label="Fewest items"
            min={0}
            allowDecimal={false}
            value={node.minItems ?? ""}
            onChange={(v) => set({ minItems: num(v) })}
          />
          <NumberInput
            size="xs"
            label="Most items"
            min={0}
            allowDecimal={false}
            value={node.maxItems ?? ""}
            onChange={(v) => set({ maxItems: num(v) })}
          />
        </Group>
      )}
      {node.type === "list" && (
        <Text size="xs" c="dimmed">
          Set up what each item is under “each item” in the tree.
        </Text>
      )}
      {node.type === "group" && role !== "root" && (
        <Text size="xs" c="dimmed">
          Add this group's fields with “Add field inside”.
        </Text>
      )}
    </Stack>
  );
}
