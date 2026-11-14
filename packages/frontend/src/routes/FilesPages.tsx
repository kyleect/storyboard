import { Alert, Anchor, Box, Loader, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, type FileScope } from "../api";
import { useReportDirty } from "../dirty";
import { projectKeys } from "../queries";
import { FilesExplorer } from "./FilesExplorer";

/*
 * The global and project pages for files (files and memory design,
 * decisions 31 and 32): the editor-style view, showing the files available
 * at the page's scope.
 */

/** The files view, for the global and project pages. */
function FilesPanel({
  scope,
  readOnly,
  height = "calc(100vh - 16rem)",
}: {
  scope: FileScope;
  readOnly?: string | undefined;
  /** How tall the view is; less is taken off with no page header. */
  height?: string;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <Box h={height} mih={420}>
      <FilesExplorer
        page={scope}
        readOnly={readOnly}
        onDirtyChange={setDirty}
      />
    </Box>
  );
}

/**
 * Global files (decision 31). The page says what it is by its place in the
 * app, so it has no heading or help text.
 */
export function GlobalFilesPage() {
  return (
    <FilesPanel scope={{ scope: "global" }} height="calc(100vh - 11rem)" />
  );
}

/** A project's files (decision 32). */
export function ProjectFilesPage({ projectId }: { projectId: string }) {
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
      <FilesPanel
        height="calc(100vh - 7rem)"
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
