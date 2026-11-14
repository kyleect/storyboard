import {
  IconAlertTriangle,
  IconBolt,
  IconBox,
  IconDatabase,
  IconFiles,
  IconFolder,
  IconInbox,
  IconMessage,
  IconRobot,
  IconSettings,
} from "@tabler/icons-react";
import { type ReactNode } from "react";
import { type WorkbenchKind, type WorkbenchTab } from "../../../lib/workbench";
import { GlobalAgentsPage, ProjectAgentsPage } from "../../agents/Agents";
import { Chat } from "../../chat/Chat";
import { GlobalFilesPage, ProjectFilesPage } from "../../files/FilesPages";
import { ErrorsPage } from "../../errors/Errors";
import { ProjectPage } from "../../project/ProjectPage";
import { SessionsPage } from "../../sessions/Sessions";
import { Settings } from "../../settings/Settings";
import { GlobalSkillsPage, ProjectSkillsPage } from "../../skills/Skills";
import {
  GlobalStructuredDataPage,
  ProjectStructuredDataPage,
} from "../../data/StructuredDataPages";
import { WorkspacesPage } from "../../workspaces/Workspaces";

/*
 * The chat workbench (chat workbench design): the icon rail, the chats tree,
 * and the tabs, in the frame the Files and Structured Data views use.
 *
 * The address decides which tab is active. A tab that is clicked navigates;
 * an address that is opened (a link, the address bar, Back) opens or
 * activates its tab. Only the active tab is mounted, and tabs with unsaved
 * edits, which stay mounted, hidden (D5).
 */

export const ICONS: Record<WorkbenchKind, ReactNode> = {
  chat: <IconMessage size={14} />,
  sessions: <IconInbox size={14} />,
  project: <IconFolder size={14} />,
  "project-files": <IconFiles size={14} />,
  "project-data": <IconDatabase size={14} />,
  agents: <IconRobot size={14} />,
  skills: <IconBolt size={14} />,
  files: <IconFiles size={14} />,
  data: <IconDatabase size={14} />,
  workspaces: <IconBox size={14} />,
  errors: <IconAlertTriangle size={14} />,
  settings: <IconSettings size={14} />,
};
/** What each page is called, in a project or globally. */
export const PAGE_LABEL: Partial<Record<WorkbenchKind, string>> = {
  sessions: "No project",
  agents: "Agents",
  skills: "Skills",
  files: "Files",
  data: "Structured Data",
  workspaces: "Workspaces",
  errors: "Errors",
  settings: "Settings",
  "project-files": "Files",
  "project-data": "Structured Data",
};
/** The page a tab shows. */
export function TabPage({ tab }: { tab: WorkbenchTab }) {
  const id = tab.key;
  switch (tab.kind) {
    case "chat":
      return <Chat sessionId={id} />;
    case "sessions":
      return <SessionsPage projectId={tab.root === "project" ? id : null} />;
    case "project":
      return <ProjectPage projectId={id} />;
    case "project-files":
      return <ProjectFilesPage projectId={id} />;
    case "project-data":
      return <ProjectStructuredDataPage projectId={id} />;
    case "agents":
      return tab.root === "project" ? (
        <ProjectAgentsPage projectId={id} />
      ) : (
        <GlobalAgentsPage />
      );
    case "skills":
      return tab.root === "project" ? (
        <ProjectSkillsPage projectId={id} />
      ) : (
        <GlobalSkillsPage />
      );
    case "files":
      return <GlobalFilesPage />;
    case "data":
      return <GlobalStructuredDataPage />;
    case "workspaces":
      return <WorkspacesPage />;
    case "errors":
      return <ErrorsPage />;
    case "settings":
      return <Settings />;
  }
}
