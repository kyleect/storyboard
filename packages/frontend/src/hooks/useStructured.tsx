import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconFileDatabase, IconSchema } from "@tabler/icons-react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectColor, SchemaInfo } from "@harness/core";
import { api, type DataItem, type DataOwner, type SchemaDetail } from "../api";
import {
  closeTab,
  isHigherScope,
  keepTab,
  nodeValue,
  rootLabel,
  tabId,
  type PageKey,
  type RootId,
} from "../lib/explorer";
import { dataKeys, schemaKeys } from "../queries";
import { useProjectColor } from "./useProjectColor";
import {
  buildTree,
  loadView,
  mergeSchemas,
  openTab,
  saveView,
  schemaTabRoot,
  tabNode,
  type NodeRef,
  type Pending,
  type StructuredRoot,
  type TabState,
} from "../lib/structured-explorer";
import type { ShellTab } from "../components/explorer/ExplorerShell";
import { CopyModal } from "../components/structured/Schemas";
import { showError } from "./useSessionActions";
import type { StructuredTreeProps } from "../components/structured/StructuredTree";
import {
  DataTab,
  newDataDraft,
  newSchemaDraft,
  SchemaTab,
  type DataDraft,
  type Draft,
  type SchemaDraft,
  type View,
} from "../components/structured/StructuredTabs";

/*
 * Everything the Structured Data view does apart from how it is laid out:
 * the lists for each root, the tree made from them, the tabs and their
 * unsaved edits, and what a click, a new name or a delete leads to. The
 * layout (`StructuredExplorer.tsx`) puts these in a shell; another view can
 * put them in a tree of its own.
 */

/** Lists of every root, as one stable value each. */
const combineResults = (
  results: { data: unknown; error: Error | null; isPending: boolean }[],
) => ({
  data: results.map((r) => r.data),
  error: results.find((r) => r.error)?.error ?? null,
  pending: results.some((r) => r.isPending),
});

const isNewKey = (key: string) => key.startsWith("new:");

export interface StructuredOptions {
  /** The roots to show. Callers keep this one value while the roots are the same. */
  roots: readonly StructuredRoot[];
  /** What the open tabs and the tree's folds are remembered under. */
  viewKey: PageKey;
  /** The root that is the view's own; others are "higher" or inherited. */
  pageRoot: RootId;
  /** Whether there are unsaved edits, for a guard against leaving. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function useStructured({
  roots,
  viewKey,
  pageRoot,
  onDirtyChange,
}: StructuredOptions) {
  const queryClient = useQueryClient();
  const rootOwner = (id: RootId): DataOwner | undefined =>
    roots.find((r) => r.id === id)?.scope;
  const labelOf = (id: RootId): string =>
    roots.find((r) => r.id === id)?.label ?? rootLabel(id);
  const ownOwner = rootOwner(pageRoot);

  const [initial] = useState(() =>
    loadView(viewKey, (v) => roots.some((r) => r.id === v)),
  );
  const [tabsState, setTabsState] = useState(() => {
    // A tab for something not yet made has no draft after a reload.
    const tabs = initial.tabs.filter(
      (t) => roots.some((r) => r.id === t.root) && !isNewKey(t.key),
    );
    const active = tabs.some((t) => tabId(t) === initial.active)
      ? initial.active
      : tabs[0]
        ? tabId(tabs[0])
        : null;
    return { tabs, active };
  });
  const [expanded, setExpanded] = useState(initial.expanded);
  const [width, setWidth] = useState(initial.width);
  const [showDeleted, setShowDeleted] = useState(initial.showDeleted);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [views, setViews] = useState<Record<string, View>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [copying, setCopying] = useState<{
    owner: DataOwner;
    schema: SchemaInfo;
  } | null>(null);
  const counter = useRef(0);

  // What is remembered between visits (not the unsaved edits).
  useEffect(() => {
    saveView(viewKey, {
      tabs: tabsState.tabs.filter((t) => !isNewKey(t.key)),
      active: tabsState.active,
      expanded,
      width,
      showDeleted,
    });
  }, [viewKey, tabsState, expanded, width, showDeleted]);

  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // ---- data: the schemas and data of every root (three lists each)
  const lists = useQueries({
    queries: roots.flatMap((r) => [
      {
        queryKey: dataKeys.schemaInfos(r.scope),
        queryFn: () => api.dataSchemas(r.scope),
      },
      {
        queryKey: schemaKeys.list(r.scope, showDeleted),
        queryFn: () => api.listSchemas(r.scope, showDeleted),
      },
      {
        queryKey: dataKeys.list(r.scope, showDeleted),
        queryFn: () => api.listData(r.scope, showDeleted),
      },
    ]),
    combine: combineResults,
  });
  const inputs = useMemo(
    () =>
      roots.map((root, i) => {
        const usable = (lists.data[3 * i] as SchemaInfo[] | undefined) ?? [];
        const own =
          (lists.data[3 * i + 1] as { schemas: SchemaInfo[] } | undefined)
            ?.schemas ?? [];
        const data =
          (lists.data[3 * i + 2] as { data: DataItem[] } | undefined)?.data ??
          [];
        return { root, schemas: mergeSchemas(own, usable), data };
      }),
    [roots, lists.data],
  );
  const tree = useMemo(() => buildTree(inputs, pending), [inputs, pending]);
  const schemaById = useMemo(() => {
    const m = new Map<string, SchemaInfo>();
    for (const i of inputs) for (const s of i.schemas) m.set(s.id, s);
    return m;
  }, [inputs]);

  /** Why a root cannot be changed: what the caller said, else the backend. */
  const reasons = useMemo<Record<RootId, string | undefined>>(
    () =>
      Object.fromEntries(
        roots.map((r, i) => {
          const list = lists.data[3 * i + 2] as
            { readOnly: string | null } | undefined;
          return [r.id, r.readOnly ?? list?.readOnly ?? undefined];
        }),
      ),
    [roots, lists.data],
  );

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: dataKeys.all });

  // ---- tabs
  const setActive = (id: string) => setTabsState((s) => ({ ...s, active: id }));
  const keep = (id: string) => setTabsState((s) => keepTab(s, id));
  const open = (tab: Omit<TabState, "transient">, permanent: boolean) =>
    setTabsState((s) => openTab(s, tab, permanent));
  const forget = (id: string) => {
    const without = <T,>(r: Record<string, T>) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));
    setDrafts(without);
    setViews(without);
  };
  const close = (id: string) => {
    setTabsState((s) => closeTab(s, id));
    forget(id);
  };
  const nameOf = (t: TabState): string => {
    const draft = drafts[tabId(t)];
    if (draft && isNewKey(t.key))
      return draft.name || (t.kind === "schema" ? "New schema" : "New data");
    return (
      tree.info.get(tabNode(t))?.name ??
      (t.kind === "schema" ? "Schema" : "Data")
    );
  };
  const requestClose = (id: string) => {
    const tab = tabsState.tabs.find((t) => tabId(t) === id);
    if (!tab || !drafts[id]) {
      close(id);
      return;
    }
    modals.openConfirmModal({
      title: `Close “${nameOf(tab)}” without saving?`,
      children: <Text size="sm">Your unsaved changes to it will be lost.</Text>,
      labels: { confirm: "Discard changes", cancel: "Keep editing" },
      confirmProps: { color: "red" },
      onConfirm: () => close(id),
    });
  };
  const activeTab = tabsState.tabs.find((t) => tabId(t) === tabsState.active);

  // ---- who a schema belongs to
  /**
   * Where a schema lives: the owner to read and change it through, and
   * whether this view may change it. The built-in schemas are read through
   * Global. A schema whose scope has no root here, such as an agent's seen
   * from a session or a project's seen from an agent, is read through the
   * root it is shown under, and cannot be changed from there.
   */
  const schemaOwner = (
    info: SchemaInfo | undefined,
    from: RootId,
  ): { owner: DataOwner; own: boolean } => {
    const fallback = rootOwner(from) ?? ownOwner;
    if (!fallback) throw new Error(`No root "${from}" in this view.`);
    if (!info) return { owner: fallback, own: true };
    if (info.scope === "builtin")
      return { owner: { scope: "global" }, own: true };
    const home = roots.find((r) => r.scope.scope === info.scope)?.scope;
    return home ? { owner: home, own: true } : { owner: fallback, own: false };
  };

  // ---- actions from the tree and the tabs
  const openRef = (ref: NodeRef, permanent: boolean) => {
    if (ref.kind === "schema") {
      const info = schemaById.get(ref.path);
      open(
        {
          kind: "schema",
          root: info ? schemaTabRoot(info.scope, ref.root, roots) : ref.root,
          key: ref.path,
        },
        permanent,
      );
    } else if (ref.kind === "data") {
      open({ kind: "data", root: ref.root, key: ref.path }, permanent);
    }
  };

  const commitPending = (p: Pending, name: string) => {
    setPending(null);
    counter.current += 1;
    const tab = {
      kind: p.kind === "new-schema" ? ("schema" as const) : ("data" as const),
      root: p.root,
      key: `new:${counter.current}`,
    };
    const id = tabId(tab);
    setDrafts((d) => ({
      ...d,
      [id]:
        p.kind === "new-schema"
          ? newSchemaDraft(name)
          : newDataDraft(name, p.schemaId),
    }));
    setViews((v) => ({ ...v, [id]: "form" }));
    open(tab, true);
  };

  const deleteSchema = (schema: SchemaInfo, from: RootId) => {
    const { owner } = schemaOwner(schema, from);
    modals.openConfirmModal({
      title: `Delete “${schema.name}”?`,
      children: (
        <Text size="sm">
          Any data made from it is deleted with it. Restoring the schema brings
          the data back.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        api
          .deleteSchema(owner, schema.id)
          .then(refresh)
          .catch(showError("Could not delete the schema")),
    });
  };

  const deleteData = (id: string, name: string, root: RootId) => {
    const owner = rootOwner(root);
    if (!owner) return;
    modals.openConfirmModal({
      title: `Delete “${name}”?`,
      children: (
        <Text size="sm">
          The agent can no longer use it. Its versions are kept, and it can be
          restored from them.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () =>
        api
          .deleteData(owner, id)
          .then(refresh)
          .catch(showError("Could not delete the data")),
    });
  };

  const activeRef = activeTab && !isNewKey(activeTab.key) ? activeTab : null;

  /** What the tree component needs, to spread onto it. */
  const treeProps: StructuredTreeProps = {
    data: tree.data,
    info: tree.info,
    roots,
    reasons,
    pageRoot,
    initialExpanded: {
      ...Object.fromEntries(
        roots.flatMap((r) => [
          [nodeValue({ root: r.id, kind: "root", path: "" }), true],
          [nodeValue({ root: r.id, kind: "schemas", path: "" }), true],
        ]),
      ),
      ...expanded,
    },
    onExpandedChange: setExpanded,
    activeValue: activeRef ? tabNode(activeRef) : null,
    showDeleted,
    onToggleDeleted: () => setShowDeleted((v) => !v),
    onOpen: openRef,
    onStartPending: setPending,
    onCommitPending: commitPending,
    onCancelPending: () => setPending(null),
    onCopy: (ref) => {
      const schema = schemaById.get(ref.path);
      if (schema)
        setCopying({ owner: schemaOwner(schema, ref.root).owner, schema });
    },
    onDelete: (ref) => {
      if (ref.kind === "schema") {
        const schema = schemaById.get(ref.path);
        if (schema) deleteSchema(schema, ref.root);
      } else if (ref.kind === "data") {
        deleteData(
          ref.path,
          tree.info.get(nodeValue(ref))?.name ?? "this data",
          ref.root,
        );
      }
    },
  };

  const where = (t: TabState): string =>
    `${labelOf(t.root)} › ${t.kind === "schema" ? "Schemas" : "Data"} › ${nameOf(t)}`;

  const colorOf = useProjectColor();
  /** The color of the project a tab's root belongs to, if it does. */
  const colorProps = (root: RootId): { iconColor?: ProjectColor } => {
    const owner = rootOwner(root);
    const color = owner?.scope === "project" ? colorOf(owner.id) : null;
    return color ? { iconColor: color } : {};
  };

  const shellTabs: ShellTab[] = tabsState.tabs.map((t) => ({
    id: tabId(t),
    label: `${nameOf(t)} · ${labelOf(t.root)}`,
    title: where(t),
    icon:
      t.kind === "schema" ? (
        <IconSchema size={14} />
      ) : (
        <IconFileDatabase size={14} />
      ),
    ...colorProps(t.root),
    transient: t.transient,
    dirty: drafts[tabId(t)] !== undefined,
  }));

  const setDraftFor = (id: string, draft: Draft | undefined) =>
    setDrafts((d) => {
      if (draft) return { ...d, [id]: draft };
      return Object.fromEntries(Object.entries(d).filter(([k]) => k !== id));
    });

  let content: React.ReactNode = null;
  if (activeTab) {
    const id = tabId(activeTab);
    const isNew = isNewKey(activeTab.key);
    const draft = drafts[id];
    const view = views[id] ?? "form";
    const common = {
      root: activeTab.root,
      isNew,
      readOnly: reasons[activeTab.root],
      view,
      onView: (v: View) => setViews((m) => ({ ...m, [id]: v })),
      onKeep: () => keep(id),
    };
    if (activeTab.kind === "schema") {
      const info = isNew ? undefined : schemaById.get(activeTab.key);
      const { owner, own } = schemaOwner(info, activeTab.root);
      content = (
        <SchemaTab
          key={id}
          {...common}
          owner={owner}
          schemaId={activeTab.key}
          info={info}
          own={own}
          higher={ownOwner ? isHigherScope(owner, ownOwner) : false}
          draft={draft?.type === "schema" ? (draft as SchemaDraft) : undefined}
          onDraft={(d) => setDraftFor(id, d)}
          onCreated={(made) => {
            close(id);
            open(
              {
                kind: "schema",
                root: schemaTabRoot(made.scope, activeTab.root, roots),
                key: made.id,
              },
              true,
            );
          }}
          onCopy={(schema) => setCopying({ owner, schema })}
          onDelete={(schema) => deleteSchema(schema, activeTab.root)}
        />
      );
    } else {
      const owner = rootOwner(activeTab.root);
      if (owner) {
        content = (
          <DataTab
            key={id}
            {...common}
            owner={owner}
            dataId={activeTab.key}
            newSchemaId={
              draft?.type === "data" ? (draft as DataDraft).schemaId : ""
            }
            higher={ownOwner ? isHigherScope(owner, ownOwner) : false}
            draft={draft?.type === "data" ? (draft as DataDraft) : undefined}
            onDraft={(d) => setDraftFor(id, d)}
            onCreated={(madeId) => {
              close(id);
              open({ kind: "data", root: activeTab.root, key: madeId }, true);
            }}
            onDelete={(d) => deleteData(d.id, d.name, activeTab.root)}
          />
        );
      }
    }
  }

  const activeDirty = activeTab
    ? drafts[tabId(activeTab)] !== undefined
    : false;
  // A schema the view can only look at is read-only too, such as a built-in.
  const activeSchemaInfo =
    activeTab?.kind === "schema" ? schemaById.get(activeTab.key) : undefined;
  const activeReason = activeTab
    ? (reasons[activeTab.root] ??
      (activeSchemaInfo &&
      (activeSchemaInfo.scope === "builtin" ||
        !schemaOwner(activeSchemaInfo, activeTab.root).own)
        ? "Read-only."
        : undefined))
    : undefined;

  const copyModal = copying ? (
    <CopyModal
      owner={copying.owner}
      schema={
        {
          ...copying.schema,
          body: null,
          versions: [],
          dataCount: 0,
        } satisfies SchemaDetail
      }
      onClose={() => setCopying(null)}
    />
  ) : null;

  return {
    /** The lists are still loading / the first one that failed. */
    loading: lists.pending,
    loadError: lists.error,
    treeProps,
    width,
    setWidth,
    tabs: shellTabs,
    active: tabsState.active,
    setActive,
    keep,
    requestClose,
    content,
    /** Where the active tab is, as "Root › Schemas › Name", for a status bar. */
    activeWhere: activeTab ? where(activeTab) : null,
    activeKind: activeTab?.kind ?? null,
    activeDirty,
    activeReason,
    copyModal,
  };
}
