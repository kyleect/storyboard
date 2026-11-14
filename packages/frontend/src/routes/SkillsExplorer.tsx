import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPackageImport } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api, type SkillOwner } from "../api";
import type { ExplorerRoot } from "../explorer-source";
import type { NodeRef } from "../files-explorer";
import { skillKeys } from "../queries";
import { findSkill, skillsSource, type SkillsPart } from "../skills-source";
import { archiveFrom, SkillImportDialog } from "./SkillImport";
import type { NodeAction } from "./FileTree";
import { showError } from "./SessionActions";
import { SourceExplorer } from "./SourceExplorer";

/*
 * The Skills view: `SourceExplorer` over the skills a page can see (skills
 * folders design, decision 22). The global page shows Built-in and Global; a
 * project's page adds Project. Built-in skills cannot be changed, but can be
 * copied to Global or exported. The agent's own skills are edited under the
 * agent (agents explorer design), not here.
 */

const SKILL_ROOTS = ["builtin", "global", "project"] as const;
const isSkillRoot = (v: unknown) =>
  typeof v === "string" && (SKILL_ROOTS as readonly string[]).includes(v);

const BUILTIN_REASON =
  "Built-in skills come with the app and cannot be changed. Copy one to Global to change it.";

/** Saves a blob under a name, the way a link to it would. */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SkillsExplorer({
  projectId,
  readOnly,
  onDirtyChange,
}: {
  /** The project whose page this is; none for the global page. */
  projectId?: string | undefined;
  /** Why the project's skills cannot be changed, when that is so. */
  readOnly?: string | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const global: SkillOwner = useMemo(() => ({ scope: "global" }), []);
  const project: SkillOwner | undefined = useMemo(
    () => (projectId ? { scope: "project", id: projectId } : undefined),
    [projectId],
  );
  /** What a person adds to on this page: its own scope. */
  const pageOwner = project ?? global;

  const roots = useMemo<ExplorerRoot[]>(() => {
    const list: ExplorerRoot[] = [
      {
        id: "builtin",
        label: "Built-in",
        source: skillsSource(global, "builtin"),
        readOnly: BUILTIN_REASON,
      },
      {
        id: "global",
        label: "Global",
        source: skillsSource(global, "own"),
        broadNote: project ? "Every session sees this skill." : undefined,
      },
    ];
    if (project) {
      list.push({
        id: "project",
        label: "Project",
        source: skillsSource(project, "own"),
        readOnly,
        broadNote: "Every session in this project sees this skill.",
      });
    }
    return list;
  }, [global, project, readOnly]);

  const ownerOfRoot = (root: string): SkillOwner =>
    root === "project" && project ? project : global;
  const partOfRoot = (root: string): SkillsPart =>
    root === "builtin" ? "builtin" : "own";

  // ---- import
  const [archive, setArchive] = useState<Blob | null>(null);
  const pick = useRef<{
    zip: HTMLInputElement | null;
    folder: HTMLInputElement | null;
  }>({
    zip: null,
    folder: null,
  });
  const picked = async (files: FileList | null, kind: "zip" | "folder") => {
    if (!files || files.length === 0) return;
    try {
      setArchive(await archiveFrom(Array.from(files), kind));
    } catch (err) {
      showError("Could not read that")(err);
    }
  };

  const nodeActions = (ref: NodeRef): NodeAction[] => {
    // A skill is a top-level folder.
    if (ref.kind !== "folder" || ref.path.includes("/")) return [];
    const actions: NodeAction[] = [
      {
        label: "Export as zip",
        onClick: () => {
          void (async () => {
            try {
              const skill = await findSkill(
                ownerOfRoot(ref.root),
                partOfRoot(ref.root),
                ref.path,
              );
              download(await api.exportSkill(skill.id), `${skill.name}.zip`);
            } catch (err) {
              showError("Could not export the skill")(err);
            }
          })();
        },
      },
    ];
    if (ref.root !== "global" || project) {
      // Built-in and project skills can be copied to Global; global ones
      // to the project.
      const target = ref.root === "global" && project ? project : global;
      const targetLabel = target === global ? "Global" : "this project";
      actions.push({
        label: `Copy to ${targetLabel}`,
        onClick: () => {
          void (async () => {
            try {
              const skill = await findSkill(
                ownerOfRoot(ref.root),
                partOfRoot(ref.root),
                ref.path,
              );
              await api.copySkill(target, skill.id);
              await queryClient.invalidateQueries({ queryKey: skillKeys.all });
              notifications.show({
                title: "Copied",
                message: `“${skill.name}” is now in ${targetLabel}.`,
              });
            } catch (err) {
              showError("Could not copy the skill")(err);
            }
          })();
        },
      });
    }
    return actions;
  };

  const importTool = (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Tooltip label="Import a skill" openDelay={400}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Import a skill"
              disabled={pageOwner === project && readOnly !== undefined}
            >
              <IconPackageImport size={16} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => pick.current.zip?.click()}>
            From a zip file
          </Menu.Item>
          <Menu.Item onClick={() => pick.current.folder?.click()}>
            From a folder
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <input
        ref={(el) => {
          pick.current.zip = el;
        }}
        type="file"
        accept=".zip,application/zip"
        hidden
        data-testid="import-zip"
        onChange={(e) => {
          void picked(e.currentTarget.files, "zip");
          e.currentTarget.value = "";
        }}
      />
      <input
        ref={(el) => {
          pick.current.folder = el;
        }}
        type="file"
        hidden
        data-testid="import-folder"
        {...({ webkitdirectory: "" } as object)}
        onChange={(e) => {
          void picked(e.currentTarget.files, "folder");
          e.currentTarget.value = "";
        }}
      />
    </>
  );

  return (
    <>
      <SourceExplorer
        roots={roots}
        pageRoot={project ? "project" : "global"}
        pageKey={project ? `project-${project.id}` : "global"}
        namespace="skills"
        isRoot={isSkillRoot}
        onDirtyChange={onDirtyChange}
        extraTools={importTool}
        nodeActions={nodeActions}
      />
      {archive && (
        <SkillImportDialog
          owner={pageOwner}
          zip={archive}
          onClose={() => setArchive(null)}
        />
      )}
    </>
  );
}
