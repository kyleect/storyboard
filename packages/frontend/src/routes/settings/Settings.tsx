import { Alert, Divider, Loader, Stack, Tabs, Title } from "@mantine/core";
import { useSettings } from "../../hooks/useSettings";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { type SettingsView } from "../../api";
import { LookAndFeel } from "./components/LookAndFeel";
import { McpServers } from "./components/McpServers";
import { Profiles } from "./components/Profiles";
import { ToolSettings } from "./components/ToolSettings";
import {
  ModelSettings,
  ServerSettings,
  SystemPrompt,
  Instructions,
  SessionTitles,
  EditingSettings,
} from "./components/ChatSettings";
import { MediaSettings } from "./components/MediaSettings";
import { Subagents, Limits } from "./components/AgentSettings";
import { TrashRetention, TrashSection } from "./components/TrashSettings";

type Section = {
  value: string;
  label: string;
  render: (view: SettingsView) => ReactNode;
};

type Area = {
  value: string;
  label: string;
  sections?: readonly Section[];
  render?: (view: SettingsView) => ReactNode;
};

const AREAS: readonly Area[] = [
  {
    value: "general",
    label: "General",
    sections: [
      {
        value: "models",
        label: "Models",
        render: (view) => <ModelSettings view={view} />,
      },
      {
        value: "server",
        label: "Server",
        render: (view) => <ServerSettings view={view} />,
      },
      { value: "profiles", label: "Profiles", render: () => <Profiles /> },
      { value: "look", label: "Look & Feel", render: () => <LookAndFeel /> },
    ],
  },
  {
    value: "chat",
    label: "Chat",
    sections: [
      {
        value: "system-prompt",
        label: "System prompt",
        render: (view) => <SystemPrompt view={view} />,
      },
      {
        value: "instructions",
        label: "Instructions",
        render: (view) => <Instructions view={view} />,
      },
      {
        value: "titles",
        label: "Session titles",
        render: (view) => <SessionTitles view={view} />,
      },
      {
        value: "editing",
        label: "Editing",
        render: (view) => <EditingSettings view={view} />,
      },
      {
        value: "media",
        label: "Media",
        render: (view) => <MediaSettings view={view} />,
      },
    ],
  },
  {
    value: "agents",
    label: "Agents",
    sections: [
      {
        value: "subagents",
        label: "Subagents",
        render: (view) => <Subagents view={view} />,
      },
      {
        value: "limits",
        label: "Limits",
        render: (view) => <Limits view={view} />,
      },
    ],
  },
  {
    value: "tools",
    label: "Tools",
    sections: [
      {
        value: "permissions",
        label: "Permissions",
        render: () => <ToolSettings />,
      },
      { value: "mcp", label: "MCP servers", render: () => <McpServers /> },
    ],
  },
  {
    value: "trash",
    label: "Trash",
    render: (view) => (
      <Stack>
        <TrashRetention view={view} />
        <Divider />
        <TrashSection />
      </Stack>
    ),
  },
];

function settingsPath(area: Area, section?: Section) {
  const chosen = section ?? area.sections?.[0];

  return chosen ? `${area.value}/${chosen.value}` : area.value;
}

function resolveSettingsPath(path: string | undefined) {
  const [areaValue, sectionValue] = (path ?? "").split("/");
  const area = AREAS.find((a) => a.value === areaValue) ?? AREAS[0];

  if (!area) throw new Error("No settings areas");

  const section =
    area.sections?.find((x) => x.value === sectionValue) ?? area.sections?.[0];

  return { area, section, canonical: settingsPath(area, section) };
}

function SubTabs({
  sections,
  value,
  view,
  onChange,
}: {
  sections: readonly Section[];
  value: string | undefined;
  view: SettingsView;
  onChange: (section: Section) => void;
}) {
  return (
    <Tabs
      value={value ?? sections[0]?.value ?? null}
      onChange={(v) => {
        const section = sections.find((x) => x.value === v);

        if (section) onChange(section);
      }}
    >
      <Tabs.List mb="md">
        {sections.map((x) => (
          <Tabs.Tab key={x.value} value={x.value}>
            {x.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {sections.map((x) => (
        <Tabs.Panel key={x.value} value={x.value}>
          {x.render(view)}
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

export function Settings() {
  const query = useSettings();
  const { _splat: path } = useParams({ strict: false });
  const navigate = useNavigate();
  const { area, section, canonical } = resolveSettingsPath(path);

  const go = (to: string, replace = false) =>
    void navigate({ to: "/settings/$", params: { _splat: to }, replace });

  useEffect(() => {
    if (path !== canonical) go(canonical, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, canonical]);

  if (query.isPending) return <Loader />;

  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;

  const view = query.data;

  return (
    <Stack maw={900}>
      <Title order={3}>Settings</Title>
      <Tabs
        value={area.value}
        onChange={(v) => {
          const chosen = AREAS.find((a) => a.value === v);

          if (chosen) go(settingsPath(chosen));
        }}
        orientation="vertical"
        styles={{ tabLabel: { textAlign: "left" } }}
      >
        <Tabs.List miw={140}>
          {AREAS.map((a) => (
            <Tabs.Tab key={a.value} value={a.value}>
              {a.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {AREAS.map((a) => (
          <Tabs.Panel key={a.value} value={a.value} pl="lg">
            {a.sections ? (
              <SubTabs
                sections={a.sections}
                value={a === area ? section?.value : undefined}
                view={view}
                onChange={(x) => go(settingsPath(a, x))}
              />
            ) : (
              a.render?.(view)
            )}
          </Tabs.Panel>
        ))}
      </Tabs>
    </Stack>
  );
}
