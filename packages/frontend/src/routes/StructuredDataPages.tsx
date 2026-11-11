import { Alert, Anchor, Box, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { useReportDirty } from "../dirty";
import { projectKeys } from "../queries";
import { StructuredExplorer } from "./StructuredExplorer";

/*
 * The global and project pages for Structured Data: schemas and the data
 * made from them, in the editor-style explorer, showing what is available at
 * the page's scope (decision 44).
 */

function Explorer({
  scope,
  readOnly,
}: {
  scope: { scope: "global" } | { scope: "project"; id: string };
  readOnly?: string | undefined;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <>
      <Box h="calc(100vh - 14rem)" mih={420}>
        <StructuredExplorer
          page={scope}
          readOnly={readOnly}
          onDirtyChange={setDirty}
        />
      </Box>
    </>
  );
}

/** Global structured data (decision 44). */
export function GlobalStructuredDataPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Structured Data</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <Explorer scope={{ scope: "global" }} />
    </Stack>
  );
}

/** A project's structured data (decision 44). */
export function ProjectStructuredDataPage({
  projectId,
}: {
  projectId: string;
}) {
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  return (
    <Stack gap="md">
      <Title order={3}>Structured Data</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : sessions in this project can use these, as well as the global ones.
      </Text>
      <Explorer
        key={projectId}
        scope={{ scope: "project", id: projectId }}
        readOnly={
          project.data.trashed_at !== null
            ? "The project is in the trash, so its data can be read but not changed."
            : undefined
        }
      />
    </Stack>
  );
}
