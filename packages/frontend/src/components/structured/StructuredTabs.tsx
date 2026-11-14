import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  applyDefaults,
  checkAnswers,
  MAX_DATA_DESCRIPTION,
  MAX_DATA_NAME,
  schemaFormAnswers,
  schemaFormValue,
  type Answers,
  type SchemaInfo,
  type SchemaNode,
} from "@harness/core";
import {
  api,
  type DataDetail,
  type DataOwner,
  type SchemaDetail,
} from "../../api";
import { rootLabel, type RootId } from "../../lib/explorer";
import { dataKeys, schemaKeys } from "../../queries";
import {
  checkTree,
  fromSchema,
  newNode,
  toSchema,
  type BuilderNode,
} from "../../lib/schema-builder";
import { scopeName } from "../../lib/structured-explorer";
import { AskUserForm } from "../AskUserForm";
import {
  Badges,
  errorsFromMessage,
  formOf,
  VersionsModal as DataVersions,
} from "./Data";
import { DataValue } from "./DataValue";
import { JsonEditor } from "./JsonEditor";
import { Builder, VersionsModal as SchemaVersions } from "./Schemas";
import { showError } from "../../lib/notify";

/*
 * What a tab of the Structured Data view shows: a schema or a piece of
 * data, in place, with the form and the JSON one toggle apart. What was
 * typed and not yet saved is the tab's draft, kept by the parent so it
 * survives switching tabs. A tab for something not yet made (a new schema
 * or new data, named in the tree) starts with a draft and is saved with
 * Create.
 */

export type View = "form" | "json";

/** A schema being edited: the builder's tree, or the JSON text, by `source`. */
export interface SchemaDraft {
  type: "schema";
  name: string;
  description: string;
  source: View;
  root: BuilderNode;
  text: string;
}

/** Data being edited: the form's answers, or the JSON text, by `source`. */
export interface DataDraft {
  type: "data";
  name: string;
  description: string;
  source: View;
  answers: Answers;
  text: string;
  /** Changes when the form must start over from `answers`. */
  formKey: number;
  /** Filled in against the schema's latest version, to migrate to it. */
  latest: boolean;
  schemaId: string;
}

export type Draft = SchemaDraft | DataDraft;

export const EMPTY_SCHEMA = { type: "object", properties: {} };

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) ?? "";

/** A fresh draft for a new schema, named. */
export function newSchemaDraft(name: string): SchemaDraft {
  const read = fromSchema(EMPTY_SCHEMA);
  return {
    type: "schema",
    name,
    description: "",
    source: "form",
    root: read.ok ? read.root : newNode("group"),
    text: pretty(EMPTY_SCHEMA),
  };
}

/** A fresh draft for new data of a schema, named. */
export function newDataDraft(name: string, schemaId: string): DataDraft {
  return {
    type: "data",
    name,
    description: "",
    source: "form",
    answers: {},
    text: "{}",
    formKey: 0,
    latest: false,
    schemaId,
  };
}

const BORDER = "1px solid var(--mantine-color-default-border)";

/** The bar over a tab's content: where it is, what it is, what can be done. */
function Toolbar({
  path,
  badges,
  actions,
}: {
  path: string;
  badges: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <Box
      px="sm"
      py={4}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        borderBottom: BORDER,
        flexWrap: "wrap",
      }}
    >
      <Box
        style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
      >
        <Text size="xs" c="dimmed" truncate>
          {path}
        </Text>
        {badges}
      </Box>
      <Box
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {actions}
      </Box>
    </Box>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: View;
  onChange: (v: View) => void;
}) {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => onChange(v as View)}
      data={[
        { value: "form", label: "Form" },
        { value: "json", label: "JSON" },
      ]}
      aria-label="Form or JSON"
    />
  );
}

/** Asks before a save that reaches more sessions than this page's own. */
function confirmHigher(
  root: RootId,
  what: string,
  verb: string,
  onConfirm: () => void,
) {
  modals.openConfirmModal({
    title: `${verb} the ${rootLabel(root)} ${what}?`,
    children: (
      <Text size="sm">
        {root === "global"
          ? "Every session sees this."
          : "Every session in this project sees this."}
      </Text>
    ),
    labels: { confirm: verb, cancel: "Cancel" },
    onConfirm,
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: dataKeys.all });
}

// ------------------------------------------------------------------ schemas

export function SchemaTab({
  owner,
  root,
  schemaId,
  isNew,
  info,
  own,
  readOnly,
  higher,
  view,
  onView,
  draft,
  onDraft,
  onKeep,
  onCreated,
  onCopy,
  onDelete,
}: {
  /** Where the schema lives (or will). */
  owner: DataOwner;
  root: RootId;
  schemaId: string;
  isNew: boolean;
  /** What the tree knows of it. */
  info: SchemaInfo | undefined;
  /** False for a schema this view can only look at, such as an agent's. */
  own: boolean;
  /** Why it cannot be changed, when it cannot. */
  readOnly: string | undefined;
  /** It is in a higher scope than the page it is edited from. */
  higher: boolean;
  view: View;
  onView: (v: View) => void;
  draft: SchemaDraft | undefined;
  onDraft: (draft: SchemaDraft | undefined) => void;
  onKeep: () => void;
  /** A new schema was made: the tab becomes its schema's tab. */
  onCreated: (made: SchemaInfo) => void;
  onCopy: (info: SchemaInfo) => void;
  onDelete: (info: SchemaInfo) => void;
}) {
  const refresh = useRefresh();
  const [versions, setVersions] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: own
      ? schemaKeys.detail(owner, schemaId)
      : [...schemaKeys.detail(owner, schemaId), "seen"],
    queryFn: async (): Promise<SchemaDetail> => {
      if (own) return api.getSchema(owner, schemaId);
      if (!info) throw new Error("This schema is not available here.");
      const body = await api.schemaBody(owner, schemaId);
      return {
        ...info,
        body,
        versions: [{ version: info.version, body }],
        dataCount: 0,
      };
    },
    enabled: !isNew,
  });
  const s: SchemaDetail | undefined = detail.data;
  const baseBody = isNew ? EMPTY_SCHEMA : s?.body;
  const baseRoot = useMemo(
    () => (baseBody === undefined ? undefined : fromSchema(baseBody)),
    [baseBody],
  );

  const restore = useMutation({
    mutationFn: () => api.restoreSchema(owner, schemaId),
    onSuccess: refresh,
    onError: showError("Could not restore the schema"),
  });
  const save = useMutation({
    mutationFn: (c: { name: string; description: string; body: unknown }) =>
      isNew ? api.createSchema(owner, c) : api.saveSchema(owner, schemaId, c),
    onSuccess: async (saved) => {
      await refresh();
      if (isNew) {
        onCreated(saved);
        return;
      }
      onDraft(undefined);
      if (s && saved.version > s.version) {
        notifications.show({
          title: `Saved as version ${saved.version}`,
          message:
            s.dataCount > 0
              ? `Its ${s.dataCount === 1 ? "piece" : `${s.dataCount} pieces`} of data stays on the earlier version until it is migrated.`
              : "No data is made from it yet.",
        });
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!isNew && detail.isPending) return <Loader size="sm" m="md" />;
  if (!isNew && detail.isError) {
    return (
      <Alert color="red" m="md">
        {detail.error.message}
      </Alert>
    );
  }
  const builtin = s?.scope === "builtin";
  const deleted = s?.deleted ?? false;
  const fixed =
    !isNew && (readOnly !== undefined || builtin || deleted || !own);
  const canBuild = baseRoot?.ok === true;
  // A schema the builder cannot show is JSON only, until it is rewritten.
  const shown: View = draft ? draft.source : canBuild ? view : "json";
  const current: SchemaDraft = draft ?? {
    type: "schema",
    name: s?.name ?? "",
    description: s?.description ?? "",
    source: shown,
    root: baseRoot?.ok ? baseRoot.root : newNode("group"),
    text: pretty(baseBody),
  };
  const edit = (patch: Partial<SchemaDraft>) => {
    if (fixed) return;
    onDraft({ ...current, ...patch });
    onKeep();
    setError(null);
  };
  const problems = shown === "form" ? checkTree(current.root) : {};

  const switchTo = (next: View) => {
    if (next === shown) return;
    setNotice(null);
    if (next === "json") {
      const text = pretty(toSchema(current.root));
      onView("json");
      if (draft) onDraft({ ...current, source: "json", text });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(current.text);
    } catch (err) {
      setNotice(`The JSON can't be read: ${(err as Error).message}`);
      return;
    }
    const read = fromSchema(parsed);
    if (!read.ok) {
      setNotice(`The builder can't show this schema:\n${read.reason}`);
      return;
    }
    onView("form");
    if (draft) onDraft({ ...current, source: "form", root: read.root });
  };

  const doSave = () => {
    if (fixed) return;
    let body: unknown;
    if (shown === "form") body = toSchema(current.root);
    else {
      try {
        body = JSON.parse(current.text);
      } catch (err) {
        setError(`The JSON can't be read: ${(err as Error).message}`);
        return;
      }
    }
    const c = {
      name: current.name,
      description: current.description,
      body,
    };
    const go = () => {
      setError(null);
      save.mutate(c);
    };
    if (higher) {
      confirmHigher(
        root,
        `schema “${current.name}”`,
        isNew ? "Create" : "Save",
        go,
      );
    } else go();
  };

  const blocked =
    current.name.trim() === "" ||
    current.description.trim() === "" ||
    Object.keys(problems).length > 0;

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <Toolbar
        path={`${rootLabel(root)} › Schemas › ${current.name || "New schema"}`}
        badges={
          <>
            {s && (
              <Badge size="xs" variant="light" color="gray">
                v{s.version}
              </Badge>
            )}
            {s && (
              <Badge size="xs" variant="light" color="gray">
                {scopeName(s.scope)}
              </Badge>
            )}
            {deleted && (
              <Badge size="xs" variant="light" color="red">
                deleted
              </Badge>
            )}
            {!deleted && fixed && readOnly && (
              <Text size="xs" c="dimmed" truncate>
                {readOnly}
              </Text>
            )}
            {builtin && (
              <Text size="xs" c="dimmed" truncate>
                Built in: copy it to change it.
              </Text>
            )}
          </>
        }
        actions={
          <>
            <ViewToggle value={shown} onChange={switchTo} />
            {!fixed && (
              <Button
                size="compact-xs"
                disabled={!isNew && draft === undefined}
                loading={save.isPending}
                onClick={() => {
                  if (blocked) {
                    setError(
                      "Give a name and a description, and fix the marked fields, to save.",
                    );
                    return;
                  }
                  doSave();
                }}
              >
                {isNew ? "Create" : "Save"}
              </Button>
            )}
            {!fixed && draft && !isNew && (
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => {
                  onDraft(undefined);
                  setError(null);
                  setNotice(null);
                }}
              >
                Revert
              </Button>
            )}
            {s && (
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => setVersions(true)}
              >
                Versions ({s.versions.length})
              </Button>
            )}
            {s && !deleted && (
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => onCopy(s)}
              >
                Copy…
              </Button>
            )}
            {s && !deleted && readOnly === undefined && own && !builtin && (
              <Tooltip
                label={
                  higher
                    ? `This is the ${rootLabel(root)} schema, shared with other sessions.`
                    : "Delete the schema"
                }
                openDelay={400}
              >
                <Button
                  size="compact-xs"
                  variant="light"
                  color="red"
                  onClick={() => onDelete(s)}
                >
                  Delete
                </Button>
              </Tooltip>
            )}
            {s && deleted && readOnly === undefined && own && (
              <Button
                size="compact-xs"
                loading={restore.isPending}
                onClick={() => restore.mutate()}
              >
                Restore
              </Button>
            )}
          </>
        }
      />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="xs" p="sm">
          {s && !isNew && (
            <Text size="xs" c="dimmed">
              {`${s.dataCount} ${s.dataCount === 1 ? "piece" : "pieces"} of data`}
              {s.copiedFrom && " · copied from another schema"}
              {draft &&
                !fixed &&
                ` · saving changed fields makes version ${s.version + 1}`}
            </Text>
          )}
          <TextInput
            label="Name"
            description="Unique among this scope's schemas."
            withAsterisk
            maxLength={MAX_DATA_NAME}
            readOnly={fixed}
            value={current.name}
            onChange={(e) => edit({ name: e.currentTarget.value })}
          />
          <Textarea
            label="Description"
            description="What the schema is for. The agent reads this."
            withAsterisk
            autosize
            minRows={2}
            maxRows={6}
            maxLength={MAX_DATA_DESCRIPTION}
            readOnly={fixed}
            value={current.description}
            onChange={(e) => edit({ description: e.currentTarget.value })}
          />
          {!canBuild && baseRoot && !baseRoot.ok && !draft && (
            <Alert color="yellow" style={{ whiteSpace: "pre-wrap" }}>
              {`The builder can't show this schema:\n${baseRoot.reason}`}
            </Alert>
          )}
          {notice && (
            <Alert color="yellow" style={{ whiteSpace: "pre-wrap" }}>
              {notice}
            </Alert>
          )}
          {shown === "form" ? (
            <Builder
              root={current.root}
              onChange={(next) => edit({ root: next })}
              problems={problems}
              readOnly={fixed}
            />
          ) : (
            <JsonEditor
              value={current.text}
              onChange={(text) => {
                if (text !== current.text) edit({ text });
              }}
              readOnly={fixed}
              label="JSON Schema"
            />
          )}
          {error && (
            <Alert color="red" style={{ whiteSpace: "pre-wrap" }}>
              {error}
            </Alert>
          )}
        </Stack>
      </ScrollArea>
      {s && versions && (
        <SchemaVersions schema={s} onClose={() => setVersions(false)} />
      )}
    </Box>
  );
}

// --------------------------------------------------------------------- data

export function DataTab({
  owner,
  root,
  dataId,
  isNew,
  newSchemaId,
  readOnly,
  higher,
  view,
  onView,
  draft,
  onDraft,
  onKeep,
  onCreated,
  onDelete,
}: {
  owner: DataOwner;
  root: RootId;
  dataId: string;
  isNew: boolean;
  /** For new data: the schema it is made from. */
  newSchemaId: string;
  readOnly: string | undefined;
  higher: boolean;
  view: View;
  onView: (v: View) => void;
  draft: DataDraft | undefined;
  onDraft: (draft: DataDraft | undefined) => void;
  onKeep: () => void;
  /** New data was made: the tab becomes its data's tab. */
  onCreated: (id: string) => void;
  onDelete: (d: DataDetail) => void;
}) {
  const refresh = useRefresh();
  const [versions, setVersions] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string> | undefined>(
    undefined,
  );
  const detail = useQuery({
    queryKey: dataKeys.detail(owner, dataId),
    queryFn: () => api.getData(owner, dataId),
    enabled: !isNew,
  });
  const newBody = useQuery({
    queryKey: schemaKeys.latest(newSchemaId),
    queryFn: () => api.schemaBody(owner, newSchemaId),
    enabled: isNew,
  });
  const d: DataDetail | undefined = detail.data;
  const latest = draft?.latest === true;
  const body: unknown = isNew
    ? newBody.data
    : d?.schema
      ? latest
        ? d.schema.latest
        : d.schema.pinned
      : undefined;
  const form = useMemo(
    () => (body === undefined ? undefined : formOf(body, "Save")),
    [body],
  );

  const save = useMutation({
    mutationFn: (c: { name: string; description: string; value: unknown }) =>
      isNew
        ? api.createData(owner, newSchemaId, c).then((r) => ({ id: r.id }))
        : latest
          ? api.migrateData(owner, dataId, c.value).then((r) => ({ id: r.id }))
          : api.saveData(owner, dataId, c).then((r) => ({ id: r.id })),
    onSuccess: async (saved) => {
      await refresh();
      if (isNew) onCreated(saved.id);
      else onDraft(undefined);
    },
    onError: (err: Error) => {
      const mapped = form ? errorsFromMessage(form, err.message) : undefined;
      setProblems(mapped);
      setError(mapped ? null : err.message);
    },
  });

  if (isNew ? newBody.isPending : detail.isPending)
    return <Loader size="sm" m="md" />;
  if (isNew ? newBody.isError : detail.isError) {
    const err = isNew ? newBody.error : detail.error;
    return (
      <Alert color="red" m="md">
        {err?.message}
      </Alert>
    );
  }
  const deleted = d?.deleted ?? false;
  const changeable =
    isNew || (readOnly === undefined && !deleted && d?.schema != null);
  const base = {
    name: d?.name ?? "",
    description: d?.description ?? "",
    value: d?.value,
  };
  const schemaNode = body as SchemaNode | undefined;
  // Data whose schema is not here can be looked at as JSON only.
  const shown: View = draft ? draft.source : form ? view : "json";
  const current: DataDraft =
    draft ??
    (form
      ? {
          type: "data",
          name: base.name,
          description: base.description,
          source: shown,
          answers: schemaFormAnswers(form, base.value),
          text: pretty(base.value),
          formKey: 0,
          latest: false,
          schemaId: newSchemaId,
        }
      : newDataDraft(base.name, newSchemaId));
  const edit = (patch: Partial<DataDraft>) => {
    if (!changeable) return;
    onDraft({ ...current, ...patch });
    onKeep();
    setError(null);
  };

  const switchTo = (next: View) => {
    if (next === shown || !form) return;
    setNotice(null);
    if (next === "json") {
      const text = pretty(schemaFormValue(form, current.answers));
      onView("json");
      if (draft) onDraft({ ...current, source: "json", text });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(current.text);
    } catch (err) {
      setNotice(`The JSON can't be read: ${(err as Error).message}`);
      return;
    }
    onView("form");
    if (draft) {
      onDraft({
        ...current,
        source: "form",
        answers: schemaFormAnswers(form, parsed),
        formKey: current.formKey + 1,
      });
    }
  };

  const trySave = (checkedAnswers?: Answers) => {
    if (!changeable || !form) return;
    if (current.name.trim() === "" || current.description.trim() === "") {
      setError("Give a name and a description to save.");
      return;
    }
    let value: unknown;
    if (shown === "form") {
      const checked = checkedAnswers
        ? { ok: true as const, answers: checkedAnswers }
        : checkAnswers(form, current.answers);
      if (!checked.ok) {
        setProblems(checked.errors);
        return;
      }
      value = schemaFormValue(form, checked.answers);
    } else {
      try {
        value = JSON.parse(current.text);
      } catch (err) {
        setError(`The JSON can't be read: ${(err as Error).message}`);
        return;
      }
    }
    const go = () => {
      setError(null);
      setProblems(undefined);
      save.mutate({
        name: current.name,
        description: current.description,
        value,
      });
    };
    if (higher) {
      confirmHigher(
        root,
        `data “${current.name}”`,
        isNew ? "Create" : "Save",
        go,
      );
    } else go();
  };

  const migrate = () => {
    if (!d?.schema || !changeable) return;
    const target = d.schema.latest as SchemaNode;
    const filled = applyDefaults(target, d.value);
    const nextForm = formOf(target, "Save");
    const answers = schemaFormAnswers(nextForm, filled);
    const checked = checkAnswers(nextForm, answers);
    setProblems(checked.ok ? undefined : checked.errors);
    onView("form");
    onDraft({
      type: "data",
      name: d.name,
      description: d.description,
      source: "form",
      answers,
      text: pretty(filled),
      formKey: current.formKey + 1,
      latest: true,
      schemaId: d.schemaId,
    });
    onKeep();
  };

  const schemaName = d?.schema?.name ?? "Unknown schema";
  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <Toolbar
        path={`${rootLabel(root)} › ${isNew ? "New data" : schemaName} › ${current.name || "New data"}`}
        badges={
          <>
            {d && (
              <Badge size="xs" variant="light" color="gray">
                {d.schema ? `v${d.schemaVersion}` : "no schema"}
              </Badge>
            )}
            {d && <Badges d={d} />}
            {!deleted && readOnly && (
              <Text size="xs" c="dimmed" truncate>
                {readOnly}
              </Text>
            )}
          </>
        }
        actions={
          <>
            {form && <ViewToggle value={shown} onChange={switchTo} />}
            {changeable && (
              <Button
                size="compact-xs"
                disabled={!isNew && draft === undefined}
                loading={save.isPending}
                onClick={() => trySave()}
              >
                {isNew
                  ? "Create"
                  : latest
                    ? `Migrate to v${d?.latestVersion}`
                    : "Save"}
              </Button>
            )}
            {changeable && draft && !isNew && (
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => {
                  onDraft(undefined);
                  setError(null);
                  setNotice(null);
                  setProblems(undefined);
                }}
              >
                Revert
              </Button>
            )}
            {d && changeable && d.outOfDate && !latest && (
              <Button
                size="compact-xs"
                color="yellow"
                variant="light"
                onClick={migrate}
              >
                Migrate to v{d.latestVersion}
              </Button>
            )}
            {d && (
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => setVersions(true)}
              >
                Versions ({d.versions.length})
              </Button>
            )}
            {d && readOnly === undefined && !deleted && (
              <Button
                size="compact-xs"
                variant="light"
                color="red"
                onClick={() => onDelete(d)}
              >
                Delete
              </Button>
            )}
          </>
        }
      />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Stack gap="xs" p="sm">
          {d && !d.schema && (
            <Text size="xs" c="dimmed">
              Its schema is not available here, so it can be viewed and deleted,
              not changed.
            </Text>
          )}
          {deleted && (
            <Text size="xs" c="dimmed">
              Deleted. Open Versions to restore it.
            </Text>
          )}
          {latest && d && (
            <Alert color="yellow" p="xs">
              {`Version ${d.latestVersion} of ${schemaName} is filled in from this data and the schema's defaults. Fix the marked fields, then migrate.`}
            </Alert>
          )}
          {d?.outOfDate && !latest && d.latestErrors.length > 0 && (
            <Alert color="yellow" title="Against the latest version" p="xs">
              {d.latestErrors.map((e) => (
                <Text key={e} size="xs">
                  {e}
                </Text>
              ))}
            </Alert>
          )}
          <TextInput
            label="Name"
            withAsterisk
            maxLength={MAX_DATA_NAME}
            readOnly={!changeable}
            value={current.name}
            onChange={(e) => edit({ name: e.currentTarget.value })}
          />
          <Textarea
            label="Description"
            description="What this piece of data is, for you and the agent."
            withAsterisk
            autosize
            minRows={2}
            maxRows={6}
            maxLength={MAX_DATA_DESCRIPTION}
            readOnly={!changeable}
            value={current.description}
            onChange={(e) => edit({ description: e.currentTarget.value })}
          />
          {notice && (
            <Alert color="yellow" style={{ whiteSpace: "pre-wrap" }}>
              {notice}
            </Alert>
          )}
          {shown === "form" && form && schemaNode ? (
            changeable ? (
              <AskUserForm
                key={`${current.formKey}-${current.latest}`}
                form={form}
                heading={false}
                hideActions
                initial={current.answers}
                onEdit={(answers) => edit({ answers })}
                {...(problems ? { extraErrors: problems } : {})}
                state={{
                  mode: "open",
                  requestId: "data-form",
                  busy: save.isPending,
                  onAnswer: (answer) => {
                    if (answer.outcome === "answered") trySave(answer.answers);
                  },
                }}
              />
            ) : d?.schema ? (
              <DataValue schema={d.schema.pinned} value={d.value} />
            ) : null
          ) : (
            <>
              {!form && d && <Code block>{pretty(d.value)}</Code>}
              {form && (
                <JsonEditor
                  value={current.text}
                  onChange={(text) => {
                    if (text !== current.text) edit({ text });
                  }}
                  readOnly={!changeable}
                  label="Data JSON"
                />
              )}
            </>
          )}
          {error && (
            <Alert color="red" style={{ whiteSpace: "pre-wrap" }}>
              {error}
            </Alert>
          )}
        </Stack>
      </ScrollArea>
      {d && versions && (
        <DataVersions
          owner={owner}
          item={d}
          readOnly={readOnly !== undefined}
          onClose={() => setVersions(false)}
        />
      )}
    </Box>
  );
}
