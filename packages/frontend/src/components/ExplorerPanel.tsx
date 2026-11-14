import { Box } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useReportDirty } from "../stores/dirty";

export function ExplorerPanel({
  children,
}: {
  children: (onDirtyChange: (dirty: boolean) => void) => ReactNode;
}) {
  const [dirty, setDirty] = useState(false);

  useReportDirty(dirty);

  return (
    <Box h="100%" mih={0}>
      {children(setDirty)}
    </Box>
  );
}
