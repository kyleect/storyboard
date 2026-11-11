import {
  Alert,
  Anchor,
  Box,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, type EntryScope } from "../api";
import { projectKeys } from "../queries";
import { NotesPanel } from "./Entries";
import { FilesExplorer } from "./FilesExplorer";
import { LeaveGuard } from "./LeaveGuard";

/*
 * The global and project pages for files and memory notes (files and memory
 * design, decisions 31 and 32). Files is the editor-style view, showing the
 * files available at the page's scope; Memory is the list of notes.
 */

/** Files and Memory tabs, for the global and project pages. */
function EntriesTabs({
  scope,
  readOnly,
}: {
  scope: EntryScope;
  readOnly?: string | undefined;
}) {
  const [tab, setTab] = useState<string>("files");
  const [dirty, setDirty] = useState(false);
  return (
    <Tabs value={tab} onChange={(v) => v && setTab(v)}>
      <Tabs.List mb="md">
        <Tabs.Tab value="files">Files</Tabs.Tab>
        <Tabs.Tab value="memory">Memory</Tabs.Tab>
      </Tabs.List>
      {/* Kept mounted, so unsaved edits survive a visit to Memory. */}
      <Tabs.Panel value="files" keepMounted>
        <Box h="calc(100vh - 16rem)" mih={420}>
          <FilesExplorer
            page={scope}
            readOnly={readOnly}
            onDirtyChange={setDirty}
          />
        </Box>
      </Tabs.Panel>
      <Tabs.Panel value="memory">
        <NotesPanel scope={scope} readOnly={readOnly} />
      </Tabs.Panel>
      {dirty && <LeaveGuard />}
    </Tabs>
  );
}

/** Global files and memory (decision 31). */
export function GlobalEntriesPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Files & memory</Title>
      <Text size="sm" c="dimmed">
        Global: every session sees these.
      </Text>
      <EntriesTabs scope={{ scope: "global" }} />
    </Stack>
  );
}

/** A project's files and memory (decision 32). */
export function ProjectEntriesPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/files" });
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <Stack gap="md">
      <Title order={3}>Files & memory</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : every session in this project sees these. Global files are shown too.
      </Text>
      <EntriesTabs
        key={projectId}
        scope={{ scope: "project", id: projectId }}
        readOnly={
          trashed
            ? "The project is in the trash, so these can be read but not changed."
            : undefined
        }
      />
    </Stack>
  );
}
