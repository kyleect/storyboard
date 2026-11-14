import {
  Box,
  Badge,
  Button,
  CloseButton,
  Group,
  Image,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import type { DraftAttachment } from "../../../stores/drafts";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef } from "react";
import { mediaKindOf, parseRef, type MediaKind } from "@harness/core";
import { api, type FileScope, type UploadedFile } from "../../../api";
import {
  ACCEPT,
  ACCEPTED_DESCRIPTION,
  attachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from "../../../lib/attachments";
import { useDraft, useDrafts, revokePreview } from "../../../stores/drafts";
import {
  blobKeys,
  fileKeys,
  sessionKeys,
  workspaceKeys,
} from "../../../queries";

export interface SessionFiles {
  sessionId: string;
  projectId: string | null;
}

export const SessionFilesContext = createContext<SessionFiles | null>(null);

const warn = (message: string) =>
  notifications.show({
    color: "yellow",
    title: "Could not attach the file",
    message,
  });

export function useAttachmentDraft(sessionId: string) {
  const queryClient = useQueryClient();
  const { items, uploading } = useDraft(sessionId);
  const patch = useDrafts((s) => s.patch);

  const update = (change: (items: DraftAttachment[]) => DraftAttachment[]) =>
    patch(sessionId, (d) => ({ ...d, items: change(d.items) }));
  const uploads = (by: number) =>
    patch(sessionId, (d) => ({ ...d, uploading: d.uploading + by }));

  const add = async (files: readonly File[]): Promise<DraftAttachment[]> => {
    const uploaded: DraftAttachment[] = [];
    for (const file of files) {
      const label = file.name || "That file";
      const mediaType = attachmentMediaType(file.name, file.type);
      if (!mediaType) {
        warn(`${label} cannot be attached. Use ${ACCEPTED_DESCRIPTION}.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        warn(
          `${label} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
        );
        continue;
      }
      uploads(1);
      try {
        const made: UploadedFile = await api.uploadFile(
          { scope: "session", id: sessionId },
          file,
          mediaType,
        );
        void queryClient.invalidateQueries({
          queryKey: fileKeys.inScope({ scope: "session", id: sessionId }),
        });
        const item: DraftAttachment = {
          ref: made.ref,
          name: made.key,
          mediaType: made.mediaType,
          kind: kindOfMedia(made.mediaType),
          previewUrl: URL.createObjectURL(file),
        };
        update((prev) => [...prev, item]);
        uploaded.push(item);
      } catch (err) {
        warn(`${label}: ${(err as Error).message}`);
      } finally {
        uploads(-1);
      }
    }
    return uploaded;
  };

  return {
    items,
    uploading,
    add,
    remove: (ref: string) =>
      update((prev) => {
        for (const i of prev) if (i.ref === ref) revokePreview(i);
        return prev.filter((i) => i.ref !== ref);
      }),
    clear: () =>
      update((prev) => {
        for (const i of prev) revokePreview(i);
        return [];
      }),
  };
}

export function AttachButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        aria-label="Choose files to attach"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Button
        variant="default"
        disabled={disabled ?? false}
        onClick={() => input.current?.click()}
      >
        Attach
      </Button>
    </>
  );
}

export function DraftAttachments({
  items,
  uploading,
  onRemove,
}: {
  items: readonly DraftAttachment[];
  uploading: number;
  onRemove: (ref: string) => void;
}) {
  if (items.length === 0 && uploading === 0) return null;
  return (
    <Group gap="xs" mb="xs">
      {items.map(({ ref, name, kind, previewUrl }) => {
        const label = name;
        return (
          <Paper key={ref} p={4}>
            <Group gap="xs" wrap="nowrap">
              {previewUrl && kind === "image" ? (
                <Image
                  src={previewUrl}
                  alt={label}
                  w={40}
                  h={40}
                  fit="cover"
                  radius="sm"
                />
              ) : (
                <Badge size="md" tt="none">
                  {kind}
                </Badge>
              )}
              <Text size="xs" maw={160} truncate="end">
                {label}
              </Text>
              {previewUrl && kind === "audio" && (
                <Box
                  component="audio"
                  controls
                  src={previewUrl}
                  aria-label={`Play ${label}`}
                  h={32}
                  maw={220}
                />
              )}
              <CloseButton
                size="xs"
                aria-label={`Remove ${label}`}
                onClick={() => onRemove(ref)}
              />
            </Group>
          </Paper>
        );
      })}
      {uploading > 0 && <Loader size="xs" aria-label="Uploading" />}
    </Group>
  );
}

const kindOfMedia = (mediaType: string): MediaKind =>
  mediaKindOf(mediaType) ?? "image";

export function MessageFiles({ files }: { files: readonly string[] }) {
  const where = useContext(SessionFilesContext);
  const choices = useQuery({
    queryKey: sessionKeys.mediaChoices(where?.sessionId ?? ""),
    queryFn: () => api.getMediaChoices(where?.sessionId as string),
    enabled: where !== null,
  });
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: ({ ref, keep }: { ref: string; keep: boolean | null }) =>
      api.setMediaChoice(where?.sessionId as string, ref, keep),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: sessionKeys.mediaChoices(where?.sessionId ?? ""),
      }),
    onError: (err) =>
      notifications.show({
        color: "red",
        title: "Could not save the choice",
        message: (err as Error).message,
      }),
  });
  return (
    <Stack gap="xs" my="xs">
      {files.map((ref) => {
        const choice = choices.data?.find((c) => c.ref === ref)?.keep;
        return (
          <Stack key={ref} gap={4}>
            <StoredFile refText={ref} />
            {where && (
              <SegmentedControl
                size="xs"
                w="fit-content"
                aria-label={`Keep ${ref} in view`}
                value={
                  choice === undefined ? "default" : choice ? "keep" : "drop"
                }
                onChange={(v) =>
                  set.mutate({
                    ref,
                    keep: v === "default" ? null : v === "keep",
                  })
                }
                data={[
                  { value: "default", label: "Default" },
                  { value: "keep", label: "Keep in view" },
                  { value: "drop", label: "Drop later" },
                ]}
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

function WorkspaceFile({
  sessionId,
  refText,
  label,
}: {
  sessionId: string;
  refText: string;
  label: string;
}) {
  const bytes = useQuery({
    queryKey: workspaceKeys.file(sessionId, refText),
    queryFn: () => api.workspaceFileUrl(sessionId, refText),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  if (bytes.isPending)
    return <Loader size="xs" aria-label={`Loading ${label}`} />;
  if (bytes.isError) {
    return (
      <Text size="xs" c="dimmed">
        {label} is no longer available.
      </Text>
    );
  }
  if (mediaKindOf(bytes.data.mediaType) === "image") {
    return (
      <Image
        src={bytes.data.url}
        alt={label}
        maw={320}
        mah={240}
        fit="contain"
        radius="sm"
      />
    );
  }
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <audio controls src={bytes.data.url} aria-label={label} />
    </Stack>
  );
}

/** A file a message names: shown when it can be found, named otherwise. */
function StoredFile({ refText }: { refText: string }) {
  const where = useContext(SessionFilesContext);
  const parsed = parseRef(refText);
  if (where && parsed?.location === "workspace") {
    return (
      <WorkspaceFile
        sessionId={where.sessionId}
        refText={refText}
        label={parsed.path}
      />
    );
  }
  return <ScopeFile refText={refText} />;
}

function ScopeFile({ refText }: { refText: string }) {
  const where = useContext(SessionFilesContext);
  const parsed = parseRef(refText);
  const scope: FileScope | undefined =
    !where || !parsed || parsed.location === "workspace"
      ? undefined
      : parsed.location === "session"
        ? { scope: "session", id: where.sessionId }
        : parsed.location === "project"
          ? where.projectId
            ? { scope: "project", id: where.projectId }
            : undefined
          : { scope: "global" };
  const label = parsed && "path" in parsed ? parsed.path : refText;
  const list = useQuery({
    queryKey: scope ? fileKeys.list(scope, false) : ["no-scope"],
    queryFn: () => api.listFiles(scope as FileScope, false),
    enabled: scope !== undefined,
  });
  const file =
    parsed && "path" in parsed
      ? list.data?.find((f) => f.key === parsed.path)
      : undefined;
  const hash = file?.blob?.hash;
  const mediaType = file?.mediaType;
  const bytes = useQuery({
    queryKey: blobKeys.file(hash ?? ""),
    queryFn: () => api.blobUrl(hash as string),
    enabled: hash !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (list.isPending && scope)
    return <Loader size="xs" aria-label={`Loading ${label}`} />;
  if (!file || !hash || !mediaType) {
    return (
      <Text size="xs" c="dimmed">
        {label} is no longer available.
      </Text>
    );
  }
  if (bytes.isPending)
    return <Loader size="xs" aria-label={`Loading ${label}`} />;
  if (bytes.isError) {
    return (
      <Text size="xs" c="red">
        Could not load {label}.
      </Text>
    );
  }
  if (mediaKindOf(mediaType) === "image") {
    return (
      <Image
        src={bytes.data}
        alt={label}
        title={refText}
        maw={320}
        mah={240}
        fit="contain"
        radius="sm"
      />
    );
  }
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <audio controls src={bytes.data} aria-label={label} />
    </Stack>
  );
}
