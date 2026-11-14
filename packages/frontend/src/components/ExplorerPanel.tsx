import { Box } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { useReportDirty } from "../stores/dirty";

export function ExplorerPanel({
  height,
  children,
}: {
  height: string;
  children: (onDirtyChange: (dirty: boolean) => void) => ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  useReportDirty(dirty);
  return (
    <Box h={height} mih={420}>
      {children(setDirty)}
    </Box>
  );
}
