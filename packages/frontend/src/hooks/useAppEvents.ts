import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, appEventsUrl } from "../api";
import { connectEventStream } from "../lib/event-stream";
import { pathForTab } from "../lib/workbench";
import { tabId } from "../lib/explorer";
import {
  agentKeys,
  dataKeys,
  errorKeys,
  mcpKeys,
  profileKeys,
  projectKeys,
  runKeys,
  sessionKeys,
  skillKeys,
  toolKeys,
  workspaceKeys,
} from "../queries";
import { useAppearance } from "../stores/appearance";
import { useLive } from "../stores/live";
import { currentProfile, setCurrentProfile } from "../stores/profile";
import { navigateWorkbench, useWorkbench } from "../stores/workbench";

type AppEvent =
  | {
      type: "agents.changed";
      data: {
        agentId: string;
        projectId: string | null;
        clearedSessions: string[];
      };
    }
  | {
      type: "projects.changed";
      data: { projectId: string };
    }
  | {
      type: "skills.changed";
      data: {
        skillId: string;
        projectId: string | null;
        agentId: string | null;
      };
    }
  | {
      type: "mcp.changed";
      data: { serverId: string };
    }
  | {
      type: "errors.changed";
      data: { sessionId: string | null };
    }
  | {
      type: "data.changed";
      data: Record<string, never>;
    }
  | {
      type: "workspaces.changed";
      data: Record<string, never>;
    }
  | {
      type: "runs.changed";
      data: { sessionId: string; runId: string };
    }
  | {
      type: "profile.switched";
      data: { profileId: string };
    }
  | {
      type: "profiles.changed";
      data: { profileId: string };
    };

export function useAppEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refreshAgents = () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.pickableAgents(),
      });
    };
    const refreshSkills = () =>
      void queryClient.invalidateQueries({ queryKey: skillKeys.all });
    const refreshErrors = () =>
      void queryClient.invalidateQueries({ queryKey: errorKeys.all });
    const refreshProjects = () =>
      void queryClient.invalidateQueries({ queryKey: projectKeys.list() });
    const refreshWorkspaces = () =>
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
    const refreshData = () =>
      void queryClient.invalidateQueries({ queryKey: dataKeys.all });
    const refreshRuns = () =>
      void queryClient.invalidateQueries({ queryKey: runKeys.active() });
    const refreshSessionLists = () =>
      void queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    const refreshMcp = () => {
      void queryClient.invalidateQueries({ queryKey: mcpKeys.all });
      void queryClient.invalidateQueries({ queryKey: toolKeys.list() });
      void queryClient.invalidateQueries({ queryKey: toolKeys.selectable() });
      void queryClient.invalidateQueries({
        queryKey: toolKeys.approvals(),
      });
    };
    const refreshProfiles = () =>
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    const applySwitch = (profileId: string) => {
      setCurrentProfile(profileId);
      useWorkbench.getState().reload();
      useAppearance.getState().reload();
      useLive.setState(useLive.getInitialState(), true);
      void queryClient.resetQueries();
      const { tabs, active, settingsPath } = useWorkbench.getState();
      const tab = tabs.find((t) => tabId(t) === active);
      navigateWorkbench(tab ? pathForTab(tab, settingsPath) : "/");
    };
    const syncProfile = () => {
      api
        .listProfiles()
        .then((listing) => {
          if (listing.active !== currentProfile()) applySwitch(listing.active);
          else refreshProfiles();
        })
        .catch(() => {});
    };
    const onMessage = (msg: MessageEvent<string>) => {
      const event = JSON.parse(msg.data) as AppEvent;
      switch (event.type) {
        case "runs.changed":
          refreshRuns();
          refreshSessionLists();
          break;
        case "errors.changed":
          refreshErrors();
          break;
        case "projects.changed":
          refreshProjects();
          break;
        case "skills.changed":
          refreshSkills();
          break;
        case "workspaces.changed":
          refreshWorkspaces();
          break;
        case "data.changed":
          refreshData();
          break;
        case "mcp.changed":
          refreshMcp();
          break;
        case "profile.switched":
          applySwitch(event.data.profileId);
          break;
        case "profiles.changed":
          refreshProfiles();
          break;
        case "agents.changed":
          refreshAgents();
          for (const id of event.data.clearedSessions) {
            void queryClient.invalidateQueries({
              queryKey: sessionKeys.detail(id),
            });
          }
          break;
      }
    };

    return connectEventStream({
      url: appEventsUrl,
      onOpen: () => {
        syncProfile();
        refreshAgents();
        refreshSkills();
        refreshErrors();
        refreshProjects();
        refreshData();
        refreshMcp();
        refreshWorkspaces();
        refreshRuns();
        refreshSessionLists();
      },
      onMessage,
    });
  }, [queryClient]);
}
