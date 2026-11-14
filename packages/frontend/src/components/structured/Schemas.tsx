import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  MultiSelect,
  NavLink,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useProjects } from "../../hooks/useProjects";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { MAX_DATA_NAME, SCHEMA_FORMATS } from "@harness/core";
import {
  api,
  type CopyTarget,
  type DataOwner,
  type SchemaDetail,
} from "../../api";
import { agentKeys, dataKeys } from "../../queries";
import {
  addField,
  changeType,
  FIELD_TYPES,
  findNode,
  flatten,
  moveField,
  newNode,
  removeField,
  updateNode,
  type BuilderNode,
  type FieldType,
  type TextFormat,
} from "../../lib/schema-builder";
import { showError } from "../../lib/notify";

function useRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: dataKeys.all });
  };
}

const typeLabel = (t: FieldType) =>
  FIELD_TYPES.find((f) => f.value === t)?.label ?? t;

export function VersionsModal({
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
        <ScrollArea.Autosize mah="60vh" w={160} flex="none">
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
          <ScrollArea.Autosize mah="60vh" flex={1} miw={0}>
            <Code block>{JSON.stringify(picked.body, null, 2)}</Code>
          </ScrollArea.Autosize>
        )}
      </Group>
    </Modal>
  );
}

export function CopyModal({
  owner,
  schema,
  onClose,
}: {
  owner: DataOwner;
  schema: SchemaDetail;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const projects = useProjects();
  const globalAgents = useQuery({
    queryKey: agentKeys.copyTargets({ scope: "global" }),
    queryFn: () => api.listAgents({ scope: "global" }, false),
  });
  const projectAgents = useQueries({
    queries: (projects.data ?? []).map((p) => ({
      queryKey: agentKeys.copyTargets({ scope: "project", id: p.id }),
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

export function Builder({
  root,
  onChange,
  problems,
  readOnly = false,
}: {
  root: BuilderNode;
  onChange: (root: BuilderNode) => void;
  problems: Record<string, string>;
  readOnly?: boolean;
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
    <Paper p="sm">
      <Group align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={4} flex={1} miw={0}>
          <Select
            size="xs"
            label="The data is"
            disabled={readOnly}
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
                  pl={6 + depth * 16}
                  py={3}
                  pr={6}
                  bdrs={4}
                  bg={
                    selected === node.id
                      ? "var(--mantine-color-default-hover)"
                      : "transparent"
                  }
                >
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" ff="monospace" truncate>
                      {role === "item" ? "each item" : node.key || "(unnamed)"}
                    </Text>
                    <Badge color="gray">{typeLabel(node.type)}</Badge>
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
              <Group gap="xs" hidden={readOnly}>
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
        <Stack
          gap="xs"
          flex={1.3}
          miw={0}
          {...(readOnly ? { component: "fieldset", disabled: true } : {})}
        >
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
              <ActionIcon aria-label="Move up" onClick={() => onMove(-1)}>
                ↑
              </ActionIcon>
              <ActionIcon aria-label="Move down" onClick={() => onMove(1)}>
                ↓
              </ActionIcon>
            </>
          )}
          {onRemove && (
            <ActionIcon
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
