import {
  Button,
  Group,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { when } from "../lib/format";
import { showError } from "../lib/notify";

interface Version {
  seq: number;
  createdAt: string | null;
}

interface Restore<V> {
  run: (seq: number) => Promise<unknown>;
  afterRestore: () => unknown;
  isCurrent: (picked: V) => boolean;
  canRestore: (picked: V) => boolean;
}

interface VersionsModalProps<V extends Version> {
  title: string;
  versions: readonly V[];
  initialSeq?: number | undefined;
  listWidth: number;
  bodyHeight: string;
  label: (version: V) => ReactNode;
  note: (version: V) => ReactNode;
  body: (version: V) => ReactNode;
  restore?: Restore<V> | undefined;
  onClose: () => void;
}

export function VersionsModal<V extends Version>({
  title,
  versions,
  initialSeq,
  listWidth,
  bodyHeight,
  label,
  note,
  body,
  restore,
  onClose,
}: VersionsModalProps<V>) {
  const newestFirst = [...versions].reverse();
  const [picked, setPicked] = useState<V | undefined>(
    newestFirst.find((v) => v.seq === initialSeq) ?? newestFirst[0],
  );
  const restoreVersion = useMutation({
    mutationFn: (seq: number) => restore?.run(seq) ?? Promise.resolve(),
    onSuccess: async () => {
      await restore?.afterRestore();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const isCurrent = picked !== undefined && !!restore?.isCurrent(picked);

  return (
    <Modal opened onClose={onClose} size="xl" title={title}>
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={listWidth} flex="none">
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={label(v)}
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" flex={1} miw={0}>
            <Group justify="space-between">
              {note(picked)}
              {restore && (
                <Button
                  size="xs"
                  disabled={!restore.canRestore(picked) || isCurrent}
                  loading={restoreVersion.isPending}
                  onClick={() => restoreVersion.mutate(picked.seq)}
                >
                  {isCurrent ? "Current" : "Make current"}
                </Button>
              )}
            </Group>
            <ScrollArea.Autosize mah={bodyHeight}>
              {body(picked)}
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}
