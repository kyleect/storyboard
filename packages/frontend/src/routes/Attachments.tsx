import {
  Badge,
  Button,
  CloseButton,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@harness/core";
import { api } from "../api";
import {
  ACCEPT,
  ACCEPTED_DESCRIPTION,
  attachmentMediaType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
} from "../attachments";
import { attachmentKeys } from "../queries";

/*
 * Files attached to messages: choosing and uploading them in the composer,
 * and showing them in the transcript.
 *
 * A file is uploaded as soon as it is chosen, pasted or dropped, and the
 * message then sends only its id. The bytes are fetched again to show them
 * in the transcript, with the token, and shown from an object URL.
 */

/** A file uploaded for the message being written. */
export interface DraftAttachment {
  attachment: Attachment;
  /** An object URL of the local file, for a thumbnail or to play it back. */
  previewUrl: string | undefined;
}

const warn = (message: string) =>
  notifications.show({
    color: "yellow",
    title: "Could not attach the file",
    message,
  });

/**
 * The files attached to the message being written in a session. They belong
 * to the session: another session starts with none.
 */
export function useAttachmentDraft(sessionId: string) {
  const [state, setState] = useState<{
    sessionId: string;
    items: DraftAttachment[];
  }>({ sessionId, items: [] });
  const items = state.sessionId === sessionId ? state.items : [];
  const [uploading, setUploading] = useState(0);

  // The latest items, for the clean-up when the composer goes away.
  const latest = useRef<DraftAttachment[]>([]);
  useEffect(() => {
    latest.current = items;
  });
  useEffect(
    () => () => {
      for (const i of latest.current) revoke(i);
    },
    [],
  );

  const update = (change: (items: DraftAttachment[]) => DraftAttachment[]) =>
    setState((prev) => ({
      sessionId,
      items: change(prev.sessionId === sessionId ? prev.items : []),
    }));

  /** Uploads files; returns the ones that were uploaded. */
  const add = async (files: readonly File[]): Promise<Attachment[]> => {
    const uploaded: Attachment[] = [];
    let room = MAX_ATTACHMENTS - items.length - uploading;
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
      if (room <= 0) {
        warn(`A message takes at most ${MAX_ATTACHMENTS} files.`);
        break;
      }
      room--;
      setUploading((n) => n + 1);
      try {
        const attachment = await api.uploadAttachment(
          sessionId,
          file,
          mediaType,
        );
        const previewUrl = URL.createObjectURL(file);
        update((prev) => [...prev, { attachment, previewUrl }]);
        uploaded.push(attachment);
      } catch (err) {
        warn(`${label}: ${(err as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    return uploaded;
  };

  return {
    items,
    /** How many uploads are in progress. */
    uploading,
    add,
    remove: (id: string) =>
      update((prev) => {
        for (const i of prev) if (i.attachment.id === id) revoke(i);
        return prev.filter((i) => i.attachment.id !== id);
      }),
    clear: () =>
      update((prev) => {
        for (const i of prev) revoke(i);
        return [];
      }),
  };
}

function revoke(item: DraftAttachment) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

/** The button that opens the file picker. */
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
          // So choosing the same file again is noticed.
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

/** The files chosen for the message being written. */
export function DraftAttachments({
  items,
  uploading,
  onRemove,
}: {
  items: readonly DraftAttachment[];
  uploading: number;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0 && uploading === 0) return null;
  return (
    <Group gap="xs" mb="xs">
      {items.map(({ attachment, previewUrl }) => {
        const label = attachment.name ?? attachment.mediaType;
        return (
          <Paper key={attachment.id} withBorder p={4}>
            <Group gap="xs" wrap="nowrap">
              {previewUrl && attachment.kind === "image" ? (
                <Image
                  src={previewUrl}
                  alt={label}
                  w={40}
                  h={40}
                  fit="cover"
                  radius="sm"
                />
              ) : (
                <Badge variant="light" tt="none">
                  {attachment.kind}
                </Badge>
              )}
              <Text size="xs" maw={160} truncate="end">
                {label}
              </Text>
              {/* Lets a recording be played back before it is sent. */}
              {previewUrl && attachment.kind === "audio" && (
                <audio
                  controls
                  src={previewUrl}
                  aria-label={`Play ${label}`}
                  style={{ height: 32, maxWidth: 220 }}
                />
              )}
              <CloseButton
                size="xs"
                aria-label={`Remove ${label}`}
                onClick={() => onRemove(attachment.id)}
              />
            </Group>
          </Paper>
        );
      })}
      {uploading > 0 && <Loader size="xs" aria-label="Uploading" />}
    </Group>
  );
}

/** The files a stored message was sent with. */
export function MessageAttachments({
  attachments,
}: {
  attachments: readonly Attachment[];
}) {
  return (
    <Stack gap="xs" my="xs">
      {attachments.map((a) => (
        <StoredAttachment key={a.id} attachment={a} />
      ))}
    </Stack>
  );
}

function StoredAttachment({ attachment }: { attachment: Attachment }) {
  const label = attachment.name ?? attachment.mediaType;
  const file = useQuery({
    queryKey: attachmentKeys.file(attachment.id),
    queryFn: () => api.attachmentUrl(attachment.id),
    // The bytes under an id never change, and the object URL has to stay
    // valid for as long as the page is open.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (file.isPending)
    return <Loader size="xs" aria-label={`Loading ${label}`} />;
  if (file.isError) {
    return (
      <Text size="xs" c="red">
        Could not load {label}.
      </Text>
    );
  }
  if (attachment.kind === "image") {
    return (
      <Image
        src={file.data}
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
      <audio controls src={file.data} aria-label={label} />
    </Stack>
  );
}
