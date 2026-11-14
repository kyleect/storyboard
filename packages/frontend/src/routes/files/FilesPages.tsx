import { Alert, Box, Loader, Stack } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type FileScope } from "../../api";
import { useReportDirty } from "../../stores/dirty";
import { projectKeys } from "../../queries";
import { FilesExplorer } from "../../components/explorer/FilesExplorer";

function FilesPanel({
  scope,
  readOnly,
  height = "calc(100vh - 16rem)",
}: {
  scope: FileScope;
  readOnly?: string | undefined;
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

export function GlobalFilesPage() {
  return (
    <FilesPanel scope={{ scope: "global" }} height="calc(100vh - 11rem)" />
  );
}

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
