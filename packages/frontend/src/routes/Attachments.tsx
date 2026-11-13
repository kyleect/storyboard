import {
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
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef } from "react";
import { mediaKindOf, parseRef, type MediaKind } from "@harness/core";
import { api, type FileScope, type UploadedFile } from "../api";
import {
  ACCEPT,
  ACCEPTED_DESCRIPTION,
  attachmentMediaType,
  MAX_ATTACHMENT_BYTES,
} from "../attachments";
import { useDraft, useDrafts, revokePreview } from "../drafts";
import { blobKeys, fileKeys, sessionKeys, workspaceKeys } from "../queries";

/*
 * Files attached to messages: choosing and uploading them in the composer,
 * and showing them in the transcript.
 *
 * A file is uploaded to the session's scope as soon as it is chosen, pasted
 * or dropped, so it is a session file like any other, and the message then
 * sends only its reference (files unification design, D9, D10). The bytes
 * are fetched again to show them in the transcript, with the token, and
 * shown from an object URL.
 */

/** A file uploaded for the message being written. */
export interface DraftAttachment {
  /** Where the file is, such as `session://cat.png`. */
  ref: string;
  /** The file's name in the session. */
  name: string;
  mediaType: string;
  kind: MediaKind;
  /** An object URL of the local file, for a thumbnail or to play it back. */
  previewUrl: string | undefined;
}

/** What a message needs to find the files it names. */
export interface SessionFiles {
  sessionId: string;
  projectId: string | null;
}

/** The session being shown, for the references in its messages. */
export const SessionFilesContext = createContext<SessionFiles | null>(null);

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
  const queryClient = useQueryClient();
  const { items, uploading } = useDraft(sessionId);
  const patch = useDrafts((s) => s.patch);

  const update = (change: (items: DraftAttachment[]) => DraftAttachment[]) =>
    patch(sessionId, (d) => ({ ...d, items: change(d.items) }));
  const uploads = (by: number) =>
    patch(sessionId, (d) => ({ ...d, uploading: d.uploading + by }));

  /** Uploads files; returns the ones that were uploaded. */
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
        // The session's files changed; refresh any list of them.
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
    /** How many uploads are in progress. */
    uploading,
    add,
    /** Takes a file off the message. It stays among the session's files. */
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
  onRemove: (ref: string) => void;
}) {
  if (items.length === 0 && uploading === 0) return null;
  return (
    <Group gap="xs" mb="xs">
      {items.map(({ ref, name, kind, previewUrl }) => {
        const label = name;
        return (
          <Paper key={ref} withBorder p={4}>
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
                <Badge variant="light" tt="none">
                  {kind}
                </Badge>
              )}
              <Text size="xs" maw={160} truncate="end">
                {label}
              </Text>
              {/* Lets a recording be played back before it is sent. */}
              {previewUrl && kind === "audio" && (
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

/**
 * The files a stored message was sent with, or a tool read. Each one has a
 * choice whether the model keeps seeing it in later turns (files unification
 * design, D14, D40): the default follows the agent and the settings.
 */
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

/** An image or audio file in a workspace, fetched from disk by the backend. */
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
    // The object URL has to stay valid for as long as the page is open.
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

/** A session, project or global file, found in its scope's list. */
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
    // The bytes under a hash never change, and the object URL has to stay
    // valid for as long as the page is open.
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
