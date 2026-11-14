import {
  ActionIcon,
  Alert,
  Button,
  FileButton,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { confirmAction } from "../../../lib/confirm";
import { useSetDefaultAgent } from "../../../hooks/useProjects";
import { useSettings } from "../../../hooks/useSettings";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import {
  IconFile,
  IconFileDatabase,
  IconFileImport,
  IconRobot,
  IconSchema,
  IconSquarePlus,
} from "@tabler/icons-react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  agentPath,
  buildTree,
  isNewKey,
  loadView,
  openTab,
  saveView,
  skillPlace,
  splitPath,
  tabAgent,
  tabNode,
  type AgentLoad,
  type AgentRootInput,
  type AgentRow,
  type NodeRef,
  type Origin,
  type TabState,
} from "../lib/agents-explorer";
import {
  api,
  ApiError,
  type AgentContent,
  type AgentDetail,
  type AgentScope,
  type DataItem,
  type DataOwner,
  type ImportConflict,
  type SchemaDetail,
  type SkillOwner,
  type SkillWithFiles,
} from "../../../api";
import { closeTab, keepTab, nodeValue, tabId } from "../../../lib/explorer";
import { useAgentFocus } from "../../../stores/agentFocus";
import {
  agentKeys,
  dataKeys,
  projectKeys,
  schemaKeys,
  skillKeys,
} from "../../../queries";
import { skillsSource, splitKey } from "../../../lib/skills-source";
import type { SchemaInfo } from "@harness/core";
import { AgentForm, contentOf } from "./AgentForm";
import { AgentsTree, type TreeAction } from "./AgentsTree";
import {
  ExplorerShell,
  type ShellTab,
} from "../../../components/explorer/ExplorerShell";
import { useProjectColor } from "../../../hooks/useProjectColor";
import { download, fileName } from "./AgentParts";
import {
  FileTab,
  type Draft as FileDraft,
} from "../../../components/explorer/FileTab";
import { CopyModal } from "../../../components/structured/Schemas";
import {
  DataTab,
  newDataDraft,
  newSchemaDraft,
  SchemaTab,
  type DataDraft,
  type Draft as StructDraft,
  type SchemaDraft,
  type View,
} from "../../../components/structured/StructuredTabs";
import { showError } from "../../../lib/notify";

const GLOBAL: AgentScope = { scope: "global" };
const BUILTIN_REASON = "A built-in agent cannot be changed.";
const INHERITED_REASON =
  "Inherited from above this agent, so it is read-only here. Open it where it lives to change it.";

const EMPTY_INHERITED: Record<Origin, readonly SkillWithFiles[]> = {
  project: [],
  global: [],
  builtin: [],
};

function askName(
  title: string,
  label: string,
  onSubmit: (name: string) => void,
) {
  const NameForm = () => {
    const [name, setName] = useState("");
    const go = () => {
      if (name.trim() === "") return;
      modals.closeAll();
      onSubmit(name.trim());
    };
    return (
      <Stack gap="xs">
        <TextInput
          data-autofocus
          label={label}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
        />
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={() => modals.closeAll()}>
            Cancel
          </Button>
          <Button size="xs" disabled={name.trim() === ""} onClick={go}>
            Create
          </Button>
        </Group>
      </Stack>
    );
  };
  modals.open({ title, children: <NameForm /> });
}

const combine = (
  results: { data: unknown; error: Error | null; isPending: boolean }[],
) => ({
  data: results.map((r) => r.data),
  error: results.find((r) => r.error)?.error ?? null,
  pending: results.map((r) => r.isPending),
});

export function AgentsExplorer({
  projectId,
  readOnly,
  onDirtyChange,
}: {
  projectId?: string | undefined;
  readOnly?: string | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const page = projectId ? `project-${projectId}` : "global";
  const projectScope = useMemo<AgentScope | undefined>(
    () => (projectId ? { scope: "project", id: projectId } : undefined),
    [projectId],
  );
  const pageRoot = projectId ? "project" : "global";

  const [initial] = useState(() => loadView(page));
  const [tabsState, setTabsState] = useState(() => {
    const tabs = initial.tabs.filter(
      (t) => !isNewKey(t.key) && (t.root !== "project" || projectId),
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
  const [agentDrafts, setAgentDrafts] = useState<Record<string, AgentContent>>(
    {},
  );
  const [fileDrafts, setFileDrafts] = useState<Record<string, FileDraft>>({});
  const [structDrafts, setStructDrafts] = useState<Record<string, StructDraft>>(
    {},
  );
  const [starts, setStarts] = useState<Record<string, AgentContent>>({});
  const [views, setViews] = useState<Record<string, View>>({});
  const [copying, setCopying] = useState<{
    owner: DataOwner;
    schema: SchemaInfo;
  } | null>(null);
  const counter = useRef(0);

  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const [value, on] of Object.entries(initial.expanded)) {
      const ref = parseRef(value);
      if (on && ref.kind === "agent") ids.add(ref.path);
    }
    for (const t of initial.tabs) ids.add(tabAgent(t));
    return ids;
  });
  const want = (id: string) =>
    setWanted((w) => (w.has(id) ? w : new Set([...w, id])));

  useEffect(() => {
    saveView(page, {
      tabs: tabsState.tabs.filter((t) => !isNewKey(t.key)),
      active: tabsState.active,
      expanded,
      width,
      showDeleted,
    });
  }, [page, tabsState, expanded, width, showDeleted]);

  const dirty =
    Object.keys(agentDrafts).length +
      Object.keys(fileDrafts).length +
      Object.keys(structDrafts).length >
    0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const request = useAgentFocus((s) => s.request);
  const clearRequest = useAgentFocus((s) => s.clear);
  const [showVersion, setShowVersion] = useState<{
    agentId: string;
    version: number;
  } | null>(null);

  const settings = useSettings();
  const project = useQuery({
    queryKey: projectKeys.detail(projectId ?? ""),
    queryFn: () => api.getProject(projectId ?? ""),
    enabled: projectId !== undefined,
  });
  const defaultId = projectId
    ? (project.data?.default_agent_id ?? null)
    : settings.data?.effective.defaultAgentId || null;
  const envLock = settings.data?.overriddenByEnv.defaultAgentId;
  const defaultLocked = projectId
    ? readOnly
    : envLock
      ? `Set by ${envLock}.`
      : undefined;
  const setDefault = useSetDefaultAgent(projectId);

  const globalAgents = useQuery({
    queryKey: agentKeys.list(GLOBAL, showDeleted),
    queryFn: () => api.listAgents(GLOBAL, showDeleted),
  });
  const projectAgents = useQuery({
    queryKey: agentKeys.list(projectScope ?? GLOBAL, showDeleted),
    queryFn: () => api.listAgents(projectScope ?? GLOBAL, showDeleted),
    enabled: projectScope !== undefined,
  });
  const rows = (list: typeof globalAgents.data): AgentRow[] =>
    (list ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      deleted: a.deleted,
      builtin: a.builtin,
      projectId: a.projectId,
      isDefault: a.id === defaultId,
      newTools: a.newTools.length,
    }));
  const roots = useMemo<AgentRootInput[]>(() => {
    const all = rows(globalAgents.data);
    const list: AgentRootInput[] = [
      {
        id: "builtin",
        label: "Built-in",
        agents: all.filter((a) => a.builtin),
      },
      { id: "global", label: "Global", agents: all.filter((a) => !a.builtin) },
    ];
    if (projectId) {
      list.push({
        id: "project",
        label: "Project",
        agents: rows(projectAgents.data),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalAgents.data, projectAgents.data, projectId]);
  const agentRows = useMemo(() => {
    const m = new Map<string, { row: AgentRow; root: string }>();
    for (const r of roots)
      for (const a of r.agents) m.set(a.id, { row: a, root: r.id });
    return m;
  }, [roots]);
  const [handled, setHandled] = useState<object | null>(null);
  const listsIn =
    !globalAgents.isPending && !(projectId && projectAgents.isPending);
  if (request && request !== handled && listsIn) {
    setHandled(request);
    const found = agentRows.get(request.agentId);
    if (found) {
      setShowVersion({ agentId: request.agentId, version: request.version });
      setTabsState((s) =>
        openTab(
          s,
          { kind: "agent", root: found.root, key: request.agentId },
          true,
        ),
      );
    }
  }
  useEffect(() => {
    if (request && request === handled) clearRequest();
  }, [request, handled, clearRequest]);

  const reasonOf = (root: string): string | undefined =>
    root === "builtin"
      ? BUILTIN_REASON
      : root === "project"
        ? readOnly
        : undefined;
  const agentReason = (agentId: string): string | undefined => {
    const a = agentRows.get(agentId);
    if (!a) return undefined;
    if (a.row.deleted)
      return "The agent is deleted, so this can be read but not changed.";
    return reasonOf(a.root);
  };

  const loadIds = useMemo(
    () => [...wanted].filter((id) => agentRows.has(id)),
    [wanted, agentRows],
  );
  const skillOwners = useMemo(() => {
    const owners: SkillOwner[] = [{ scope: "global" }];
    const projects = new Set<string>();
    for (const id of loadIds) {
      const p = agentRows.get(id)?.row.projectId;
      if (p) projects.add(p);
    }
    for (const p of projects) owners.push({ scope: "project", id: p });
    return owners;
  }, [loadIds, agentRows]);

  const shared = useQueries({
    queries: skillOwners.map((o) => ({
      queryKey: skillKeys.withFiles(o, "own", showDeleted),
      queryFn: () => api.listSkillTree(o, showDeleted),
      enabled: loadIds.length > 0,
    })),
    combine,
  });
  const lists = useQueries({
    queries: loadIds.flatMap((id) => {
      const owner = { scope: "agent", id } as const;
      return [
        {
          queryKey: skillKeys.withFiles(owner, "own", showDeleted),
          queryFn: () => api.listSkillTree(owner, showDeleted),
        },
        {
          queryKey: dataKeys.schemaInfos(owner),
          queryFn: () => api.dataSchemas(owner),
        },
        {
          queryKey: schemaKeys.list(owner, showDeleted),
          queryFn: () => api.listSchemas(owner, showDeleted),
        },
        {
          queryKey: dataKeys.list(owner, showDeleted),
          queryFn: () => api.listData(owner, showDeleted),
        },
      ];
    }),
    combine,
  });

  const loaded = useMemo(() => {
    const m = new Map<string, AgentLoad>();
    const sharedBy = (o: SkillOwner) =>
      (shared.data[
        skillOwners.findIndex(
          (x) =>
            x.scope === o.scope &&
            ("id" in x ? x.id : "") === ("id" in o ? o.id : ""),
        )
      ] as SkillWithFiles[] | undefined) ?? [];
    loadIds.forEach((id, i) => {
      const at = 4 * i;
      if (lists.pending.slice(at, at + 4).some(Boolean)) return;
      const projectOf = agentRows.get(id)?.row.projectId;
      const global = sharedBy({ scope: "global" });
      const inherited: Record<Origin, readonly SkillWithFiles[]> = {
        ...EMPTY_INHERITED,
        project: projectOf
          ? sharedBy({ scope: "project", id: projectOf }).filter(
              (s) => s.scope === "project",
            )
          : [],
        global: global.filter((s) => s.scope === "global"),
        builtin: global.filter((s) => s.scope === "builtin"),
      };
      const own =
        (lists.data[at] as SkillWithFiles[] | undefined)?.filter(
          (s) => s.scope === "agent",
        ) ?? [];
      const usable = (lists.data[at + 1] as SchemaInfo[] | undefined) ?? [];
      const ownSchemas =
        (lists.data[at + 2] as { schemas: SchemaInfo[] } | undefined)
          ?.schemas ?? [];
      const byId = new Map<string, SchemaInfo>();
      for (const s of usable) byId.set(s.id, s);
      for (const s of ownSchemas) byId.set(s.id, s);
      m.set(id, {
        skills: { own, inherited },
        schemas: {
          schemas: [...byId.values()],
          data:
            (lists.data[at + 3] as { data: DataItem[] } | undefined)?.data ??
            [],
        },
      });
    });
    return m;
  }, [loadIds, lists.data, lists.pending, shared.data, skillOwners, agentRows]);

  const tree = useMemo(() => buildTree(roots, loaded), [roots, loaded]);
  const loadError =
    lists.error ?? shared.error ?? globalAgents.error ?? projectAgents.error;
  const loading =
    globalAgents.isPending ||
    (projectId !== undefined && projectAgents.isPending);

  const open = (tab: Omit<TabState, "transient">, permanent: boolean) => {
    want(tabAgent(tab));
    setTabsState((s) => openTab(s, tab, permanent));
  };
  const keep = (id: string) => setTabsState((s) => keepTab(s, id));
  const forget = (id: string) => {
    const without = <T,>(r: Record<string, T>) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));
    setAgentDrafts(without);
    setFileDrafts(without);
    setStructDrafts(without);
    setStarts(without);
    setViews(without);
  };
  const close = (id: string) => {
    setTabsState((s) => closeTab(s, id));
    forget(id);
  };
  const drafted = (id: string) =>
    id in agentDrafts || id in fileDrafts || id in structDrafts;
  const nameOf = (t: TabState): string => {
    const id = tabId(t);
    if (t.kind === "agent") {
      const a = agentDrafts[id];
      if (isNewKey(t.key)) return a?.name || starts[id]?.name || "New agent";
      return agentRows.get(t.key)?.row.name ?? "Agent";
    }
    if (t.kind === "skill") return skillPlace(refOf(t)).key;
    const draft = structDrafts[id];
    if (isNewKey(t.key))
      return draft?.name || (t.kind === "schema" ? "New schema" : "New data");
    return (
      tree.info.get(tabNode(t))?.name ??
      (t.kind === "schema" ? "Schema" : "Data")
    );
  };
  const requestClose = (id: string) => {
    const tab = tabsState.tabs.find((t) => tabId(t) === id);
    if (!tab || !drafted(id)) {
      close(id);
      return;
    }
    confirmAction({
      title: `Close “${nameOf(tab)}” without saving?`,
      message: <>Your unsaved changes to it will be lost.</>,
      confirm: "Discard changes",
      cancel: "Keep editing",
      danger: true,
      onConfirm: () => close(id),
    });
  };
  const activeTab = tabsState.tabs.find((t) => tabId(t) === tabsState.active);

  const rootLabel = (root: string) =>
    roots.find((r) => r.id === root)?.label ?? root;

  const openRef = (ref: NodeRef, permanent: boolean) => {
    const [agentId = ""] = splitPath(ref.path, 1);
    if (ref.kind === "agent") {
      open({ kind: "agent", root: ref.root, key: ref.path }, permanent);
    } else if (ref.kind === "file") {
      open({ kind: "skill", root: ref.root, key: ref.path }, permanent);
    } else if (ref.kind === "schema" || ref.kind === "data") {
      open(
        {
          kind: ref.kind,
          root: ref.root,
          key: agentPath(agentId, splitPath(ref.path, 1)[1] ?? ""),
        },
        permanent,
      );
    }
  };

  const newAgent = (root: "global" | "project", start?: AgentContent) => {
    counter.current += 1;
    const tab = { kind: "agent" as const, root, key: `new:${counter.current}` };
    const id = tabId(tab);
    if (start) setStarts((s) => ({ ...s, [id]: start }));
    setTabsState((s) => openTab(s, tab, true));
  };

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: skillKeys.all }),
      queryClient.invalidateQueries({ queryKey: dataKeys.all }),
      queryClient.invalidateQueries({ queryKey: schemaKeys.all }),
    ]);

  const newSkill = (agentId: string, root: string) =>
    askName("New skill", "Skill name", (name) => {
      void api
        .createSkill(
          { scope: "agent", id: agentId },
          {
            name,
            description: "Describe what this skill does and when to use it.",
            body: "",
          },
        )
        .then(async () => {
          await refresh();
          open(
            {
              kind: "skill",
              root,
              key: agentPath(agentId, "own", `${name}/SKILL.md`),
            },
            true,
          );
        })
        .catch(showError("Could not create the skill"));
    });

  const newFile = (agentId: string, root: string, skill: string) =>
    askName("New file", "File name, such as refs/notes.md", (name) => {
      void (async () => {
        try {
          const found = (
            await api.listSkillTree({ scope: "agent", id: agentId }, false)
          ).find((s) => s.name === skill);
          if (!found) throw new Error(`There is no skill named “${skill}”.`);
          await api.putSkillFile(found.id, name, "");
          await refresh();
          open(
            {
              kind: "skill",
              root,
              key: agentPath(agentId, "own", `${skill}/${name}`),
            },
            true,
          );
        } catch (err) {
          showError("Could not create the file")(err);
        }
      })();
    });

  const deleteSkillPath = (
    agentId: string,
    skill: string,
    path: string,
    what: string,
  ) =>
    confirmAction({
      title: `Delete “${what}”?`,
      message: <>Its versions are kept, and it can be restored.</>,
      confirm: "Delete",
      cancel: "Cancel",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const found = (
              await api.listSkillTree({ scope: "agent", id: agentId }, true)
            ).find((s) => s.name === skill && !s.deleted);
            if (!found) throw new Error(`There is no skill named “${skill}”.`);
            if (path === "") await api.deleteSkill(found.id);
            else await api.deleteSkillPath(found.id, path);
            await refresh();
          } catch (err) {
            showError("Could not delete it")(err);
          }
        })();
      },
    });

  const newSchema = (agentId: string, root: string) =>
    askName("New schema", "Schema name", (name) => {
      counter.current += 1;
      const tab = {
        kind: "schema" as const,
        root,
        key: agentPath(agentId, `new:${counter.current}`),
      };
      const id = tabId(tab);
      setStructDrafts((d) => ({ ...d, [id]: newSchemaDraft(name) }));
      setViews((v) => ({ ...v, [id]: "form" }));
      open(tab, true);
    });

  const newData = (agentId: string, root: string, schemaId: string) =>
    askName("New data", "Data name", (name) => {
      counter.current += 1;
      const tab = {
        kind: "data" as const,
        root,
        key: agentPath(agentId, `new:${counter.current}`),
      };
      const id = tabId(tab);
      setStructDrafts((d) => ({ ...d, [id]: newDataDraft(name, schemaId) }));
      setViews((v) => ({ ...v, [id]: "form" }));
      open(tab, true);
    });

  const deleteSchema = (agentId: string, schema: SchemaInfo) =>
    confirmAction({
      title: `Delete “${schema.name}”?`,
      message: (
        <>
          Any data made from it is deleted with it. Restoring the schema brings
          the data back.
        </>
      ),
      confirm: "Delete",
      cancel: "Cancel",
      danger: true,
      onConfirm: () =>
        api
          .deleteSchema({ scope: "agent", id: agentId }, schema.id)
          .then(refresh)
          .catch(showError("Could not delete the schema")),
    });

  const deleteData = (agentId: string, id: string, name: string) =>
    confirmAction({
      title: `Delete “${name}”?`,
      message: (
        <>
          The agent can no longer use it. Its versions are kept, and it can be
          restored from them.
        </>
      ),
      confirm: "Delete",
      cancel: "Cancel",
      danger: true,
      onConfirm: () =>
        api
          .deleteData({ scope: "agent", id: agentId }, id)
          .then(refresh)
          .catch(showError("Could not delete the data")),
    });

  const importFile = useMutation({
    mutationFn: (a: { markdown: string; replace: boolean }) =>
      api.importAgent(projectScope ?? GLOBAL, a.markdown, a.replace),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      open({ kind: "agent", root: pageRoot, key: result.agent.id }, true);
      for (const warning of result.warnings) {
        notifications.show({
          color: "yellow",
          title: "Imported with changes",
          message: warning,
        });
      }
    },
    onError: (err: Error, a) => {
      const conflict =
        err instanceof ApiError && err.status === 409
          ? (err.body as { conflict?: ImportConflict } | undefined)?.conflict
          : undefined;
      if (!conflict) {
        showError("Could not import the agent")(err);
        return;
      }
      confirmAction({
        title: "An agent with this name exists",
        message: (
          <>
            {err.message}Replace it? The file becomes its next version
            {conflict.deleted ? ", and the deleted agent is restored" : ""};
            earlier versions are kept.
          </>
        ),
        confirm: "Replace",
        cancel: "Cancel",
        onConfirm: () =>
          importFile.mutate({ markdown: a.markdown, replace: true }),
      });
    },
  });

  const actionsFor = (ref: NodeRef): TreeAction[] => {
    const [agentId = "", rest = ""] = splitPath(ref.path, 1);
    const agent = agentRows.get(agentId);
    const editable = agent !== undefined && agentReason(agentId) === undefined;
    const list: TreeAction[] = [];
    switch (ref.kind) {
      case "agent": {
        if (!agent) return [];
        list.push({
          label: "Export",
          onClick: () => {
            void api
              .exportAgent(agent.row.id)
              .then((text) => download(fileName(agent.row.name), text))
              .catch(showError("Could not export the agent"));
          },
        });
        if (agent.row.builtin) {
          list.push({
            label: "Copy to global",
            onClick: () => void copyBuiltin(agent.row.id),
          });
        }
        return list;
      }
      case "skills":
        return editable
          ? [{ label: "New skill", onClick: () => newSkill(agentId, ref.root) }]
          : [];
      case "skill": {
        const p = skillPlace(ref);
        if (p.origin !== "own" || !editable) return [];
        return [
          {
            label: "New file",
            onClick: () => newFile(agentId, ref.root, p.key),
          },
          {
            label: "Delete skill",
            color: "red",
            onClick: () => deleteSkillPath(agentId, p.key, "", p.key),
          },
        ];
      }
      case "file": {
        const p = skillPlace(ref);
        if (p.origin !== "own" || !editable) return [];
        const [skill = "", path = ""] = splitKey(p.key);
        return path === ""
          ? []
          : [
              {
                label: "Delete file",
                color: "red",
                onClick: () => deleteSkillPath(agentId, skill, path, path),
              },
            ];
      }
      case "schemas":
        return editable
          ? [
              {
                label: "New schema",
                onClick: () => newSchema(agentId, ref.root),
              },
            ]
          : [];
      case "schema": {
        const info = tree.info.get(nodeValue(ref));
        const schema = loaded
          .get(agentId)
          ?.schemas.schemas.find((s) => s.id === rest);
        if (!schema || !editable) return [];
        if (!schema.deleted)
          list.push({
            label: "New data",
            onClick: () => newData(agentId, ref.root, schema.id),
          });
        if (!info?.inherited && !schema.deleted)
          list.push({
            label: "Delete",
            color: "red",
            onClick: () => deleteSchema(agentId, schema),
          });
        return list;
      }
      case "data":
        return editable
          ? [
              {
                label: "Delete",
                color: "red",
                onClick: () =>
                  deleteData(
                    agentId,
                    rest,
                    tree.info.get(nodeValue(ref))?.name ?? "this data",
                  ),
              },
            ]
          : [];
      default:
        return [];
    }
  };

  const copyBuiltin = async (id: string) => {
    try {
      const source = await queryClient.fetchQuery({
        queryKey: agentKeys.detail(id),
        queryFn: () => api.getAgent(id),
      });
      newAgent("global", {
        ...contentOf(source),
        name: `${source.name} (copy)`,
        subagent: false,
      });
    } catch (err) {
      showError("Could not copy the agent")(err);
    }
  };

  const targetRoot: "global" | "project" = projectId ? "project" : "global";
  const newAgentLocked = reasonOf(targetRoot);
  const header: ReactNode = (
    <>
      <Tooltip label={newAgentLocked ?? "New agent"} openDelay={400}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="New agent"
          disabled={newAgentLocked !== undefined}
          onClick={() => newAgent(targetRoot)}
        >
          <IconSquarePlus size={16} />
        </ActionIcon>
      </Tooltip>
      <FileButton
        accept=".md,text/markdown,text/plain"
        onChange={(file) => {
          if (!file) return;
          void file
            .text()
            .then((markdown) =>
              importFile.mutate({ markdown, replace: false }),
            );
        }}
      >
        {(props) => (
          <Tooltip label={newAgentLocked ?? "Import an agent"} openDelay={400}>
            <ActionIcon
              {...props}
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Import"
              disabled={newAgentLocked !== undefined}
              loading={importFile.isPending}
            >
              <IconFileImport size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </FileButton>
    </>
  );

  const activeRef = activeTab && !isNewKey(activeTab.key) ? activeTab : null;
  const sidebar = loading ? (
    <Loader size="sm" m="sm" aria-label="Loading the agents" />
  ) : (
    <>
      {loadError && (
        <Alert color="red" m="xs" p="xs">
          {loadError.message}
        </Alert>
      )}
      <AgentsTree
        data={tree.data}
        info={tree.info}
        initialExpanded={{
          ...Object.fromEntries(
            roots.map((r) => [
              nodeValue({ root: r.id, kind: "root", path: "" }),
              true,
            ]),
          ),
          ...expanded,
        }}
        onExpandedChange={(state) => {
          setExpanded(state);
          for (const [value, on] of Object.entries(state)) {
            const ref = parseRef(value);
            if (on && ref.kind === "agent") want(ref.path);
          }
        }}
        activeValue={activeRef ? tabNode(activeRef) : null}
        showDeleted={showDeleted}
        onToggleDeleted={() => setShowDeleted((v) => !v)}
        onOpen={openRef}
        actionsFor={actionsFor}
        header={header}
        defaultId={defaultId}
        defaultLocked={defaultLocked}
        onSetDefault={(id) => setDefault.mutate(id)}
      />
    </>
  );

  const KIND_ICON: Record<TabState["kind"], ReactNode> = {
    agent: <IconRobot size={14} />,
    skill: <IconFile size={14} />,
    schema: <IconSchema size={14} />,
    data: <IconFileDatabase size={14} />,
  };
  const projectColor = useProjectColor()(projectId);
  const shellTabs: ShellTab[] = tabsState.tabs.map((t) => ({
    id: tabId(t),
    label: nameOf(t),
    title: `${rootLabel(t.root)} › ${agentRows.get(tabAgent(t))?.row.name ?? "New agent"} › ${nameOf(t)}`,
    icon: KIND_ICON[t.kind],
    ...(projectColor && t.root === "project"
      ? { iconColor: projectColor }
      : {}),
    transient: t.transient,
    dirty: drafted(tabId(t)),
  }));

  const setStruct = (id: string, draft: StructDraft | undefined) =>
    setStructDrafts((d) =>
      draft
        ? { ...d, [id]: draft }
        : Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)),
    );

  let content: ReactNode = null;
  let activeReason: string | undefined;
  if (activeTab) {
    const id = tabId(activeTab);
    const agentId = tabAgent(activeTab);
    const reason = agentReason(agentId);
    if (activeTab.kind === "agent") {
      const isNew = isNewKey(activeTab.key);
      content = (
        <AgentTabContent
          key={id}
          agentId={isNew ? undefined : activeTab.key}
          root={activeTab.root}
          projectId={projectId}
          readOnly={activeTab.root === "project" ? readOnly : undefined}
          start={starts[id]}
          draft={agentDrafts[id]}
          onDraft={(d) =>
            setAgentDrafts((m) =>
              d
                ? { ...m, [id]: d }
                : Object.fromEntries(
                    Object.entries(m).filter(([k]) => k !== id),
                  ),
            )
          }
          onKeep={() => keep(id)}
          onSaved={(savedId) => {
            if (isNew) {
              close(id);
              open({ kind: "agent", root: activeTab.root, key: savedId }, true);
            }
          }}
          onDeleted={() => close(id)}
          openVersion={
            showVersion?.agentId === activeTab.key
              ? showVersion.version
              : undefined
          }
          onCopy={(source) =>
            newAgent("global", {
              ...contentOf(source),
              name: `${source.name} (copy)`,
              subagent: false,
            })
          }
        />
      );
      const a = agentRows.get(activeTab.key);
      activeReason = a
        ? (agentReason(a.row.id) ??
          (a.row.builtin ? BUILTIN_REASON : undefined))
        : reasonOf(activeTab.root);
    } else if (activeTab.kind === "skill") {
      const p = skillPlace(refOf(activeTab));
      const owner: SkillOwner =
        p.origin === "own"
          ? { scope: "agent", id: p.agentId }
          : p.origin === "project"
            ? {
                scope: "project",
                id: agentRows.get(p.agentId)?.row.projectId ?? "",
              }
            : { scope: "global" };
      const readOnlyReason = p.origin === "own" ? reason : INHERITED_REASON;
      activeReason = readOnlyReason;
      content = (
        <FileTab
          key={id}
          source={skillsSource(
            owner,
            p.origin === "builtin" ? "builtin" : "own",
          )}
          rootLabel={rootLabel(activeTab.root)}
          {...(projectColor && activeTab.root === "project"
            ? { rootColor: projectColor }
            : {})}
          fileKey={p.key}
          readOnly={readOnlyReason}
          broadNote={undefined}
          draft={fileDrafts[id]}
          onDraft={(d) =>
            setFileDrafts((m) =>
              d
                ? { ...m, [id]: d }
                : Object.fromEntries(
                    Object.entries(m).filter(([k]) => k !== id),
                  ),
            )
          }
          onKeep={() => keep(id)}
          onCursor={() => undefined}
        />
      );
    } else {
      const owner: DataOwner = { scope: "agent", id: agentId };
      const isNew = isNewKey(activeTab.key);
      const itemId = splitPath(activeTab.key, 1)[1] ?? "";
      const draft = structDrafts[id];
      const view = views[id] ?? "form";
      const common = {
        root: activeTab.root,
        isNew,
        readOnly: reason,
        view,
        onView: (v: View) => setViews((m) => ({ ...m, [id]: v })),
        onKeep: () => keep(id),
        higher: false,
      };
      activeReason = reason;
      if (activeTab.kind === "schema") {
        const info = isNew
          ? undefined
          : loaded.get(agentId)?.schemas.schemas.find((s) => s.id === itemId);
        const own = info === undefined || info.scope === "agent";
        if (!own || info?.scope === "builtin")
          activeReason = reason ?? INHERITED_REASON;
        content = (
          <SchemaTab
            key={id}
            {...common}
            owner={owner}
            schemaId={itemId}
            info={info}
            own={own}
            draft={
              draft?.type === "schema" ? (draft as SchemaDraft) : undefined
            }
            onDraft={(d) => setStruct(id, d)}
            onCreated={(made) => {
              close(id);
              open(
                {
                  kind: "schema",
                  root: activeTab.root,
                  key: agentPath(agentId, made.id),
                },
                true,
              );
            }}
            onCopy={(schema) => setCopying({ owner, schema })}
            onDelete={(schema) => deleteSchema(agentId, schema)}
          />
        );
      } else {
        content = (
          <DataTab
            key={id}
            {...common}
            owner={owner}
            dataId={itemId}
            newSchemaId={
              draft?.type === "data" ? (draft as DataDraft).schemaId : ""
            }
            draft={draft?.type === "data" ? (draft as DataDraft) : undefined}
            onDraft={(d) => setStruct(id, d)}
            onCreated={(madeId) => {
              close(id);
              open(
                {
                  kind: "data",
                  root: activeTab.root,
                  key: agentPath(agentId, madeId),
                },
                true,
              );
            }}
            onDelete={(d) => deleteData(agentId, d.id, d.name)}
          />
        );
      }
    }
  }

  const activeDirty = activeTab ? drafted(tabId(activeTab)) : false;
  const KIND_LABEL: Record<TabState["kind"], string> = {
    agent: "Agent",
    skill: "Skill file",
    schema: "Schema",
    data: "Data",
  };

  return (
    <>
      <ExplorerShell
        width={width}
        onWidthChange={setWidth}
        sidebar={sidebar}
        tabs={shellTabs}
        active={tabsState.active}
        onActivate={(id) => setTabsState((s) => ({ ...s, active: id }))}
        onKeep={keep}
        onRequestClose={requestClose}
        content={content}
        empty="Open an agent from the tree."
        tabListLabel="Open agents"
        resizeLabel="Resize the agents tree"
        statusLeft={
          activeTab
            ? `${rootLabel(activeTab.root)} › ${agentRows.get(tabAgent(activeTab))?.row.name ?? "New agent"} › ${nameOf(activeTab)}`
            : "Nothing open"
        }
        statusRight={
          activeTab && (
            <>
              <Text size="xs" c="dimmed">
                {KIND_LABEL[activeTab.kind]}
              </Text>
              <Text size="xs" c={activeDirty ? "yellow" : "dimmed"}>
                {activeReason
                  ? "Read-only"
                  : activeDirty
                    ? "Unsaved changes"
                    : "Saved"}
              </Text>
            </>
          )
        }
      />
      {copying && (
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
      )}
    </>
  );
}

function AgentTabContent({
  agentId,
  root,
  projectId,
  readOnly,
  start,
  draft,
  onDraft,
  onKeep,
  onSaved,
  onDeleted,
  onCopy,
  openVersion,
}: {
  agentId: string | undefined;
  root: string;
  projectId: string | undefined;
  readOnly: string | undefined;
  start: AgentContent | undefined;
  draft: AgentContent | undefined;
  onDraft: (d: AgentContent | undefined) => void;
  onKeep: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onCopy: (source: AgentDetail) => void;
  openVersion: number | undefined;
}) {
  const agent = useQuery({
    queryKey: agentKeys.detail(agentId ?? ""),
    queryFn: () => api.getAgent(agentId ?? ""),
    enabled: agentId !== undefined,
  });
  if (agentId !== undefined && agent.isPending)
    return <Loader size="sm" m="sm" />;
  if (agentId !== undefined && agent.isError)
    return (
      <Alert color="red" m="sm">
        {agent.error.message}
      </Alert>
    );
  const scope: AgentScope =
    root === "project" && projectId
      ? { scope: "project", id: projectId }
      : GLOBAL;
  return (
    <AgentForm
      scope={scope}
      agent={agentId !== undefined ? agent.data : undefined}
      start={start}
      readOnly={readOnly}
      draft={draft}
      onDraft={onDraft}
      onKeep={onKeep}
      onSaved={onSaved}
      onDeleted={onDeleted}
      onCopy={onCopy}
      openVersion={openVersion}
    />
  );
}

function parseRef(value: string): NodeRef {
  const first = value.indexOf("|");
  const second = value.indexOf("|", first + 1);
  return {
    root: value.slice(0, first),
    kind: value.slice(first + 1, second) as NodeRef["kind"],
    path: value.slice(second + 1),
  };
}

function refOf(t: TabState): NodeRef {
  return { root: t.root, kind: "file", path: t.key };
}
