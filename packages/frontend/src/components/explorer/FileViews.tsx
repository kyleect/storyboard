import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Image,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import utils from "../../styles/utilities.module.css";
import { VersionsModal as GenericVersionsModal } from "../VersionsModal";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fileNameProblem,
  mediaKindOf,
  type BlobRef,
  type MediaType,
} from "@harness/core";
import { api, type DerivedText, type FileDetail } from "../../api";
import type { ExplorerSource } from "../../lib/explorer-source";
import { blobKeys } from "../../queries";
import { Markdown } from "../Markdown";
import { showError } from "../../lib/notify";

const FILE_TYPES: { value: MediaType; label: string }[] = [
  { value: "text/plain", label: "Plain" },
  { value: "text/markdown", label: "Markdown" },
  { value: "application/json", label: "JSON" },
];

export const nameError = (name: string): string | undefined => {
  if (name === "") return undefined;

  const problem = fileNameProblem(name);

  return problem ? `Not a valid name: ${problem}.` : undefined;
};

export function ValueView({
  mediaType,
  value,
  blob,
}: {
  mediaType?: MediaType;
  value: string;
  blob?: BlobRef | undefined;
}) {
  const [showSource, setShowSource] = useState(false);

  if (mediaType && mediaKindOf(mediaType) && blob) {
    return <BinaryPreview mediaType={mediaType} blob={blob} />;
  }

  if (mediaType === "text/markdown" && value !== "") {
    return (
      <Stack gap="xs">
        <SegmentedControl
          size="xs"
          w="fit-content"
          value={showSource ? "source" : "rendered"}
          onChange={(v) => setShowSource(v === "source")}
          data={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
          ]}
        />
        {showSource ? (
          <SourceView value={value} />
        ) : (
          <Paper p="sm">
            <Markdown>{value}</Markdown>
          </Paper>
        )}
      </Stack>
    );
  }

  if (mediaType === "application/json") {
    let pretty = value;

    try {
      pretty = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // not JSON: show the text as it is
    }

    return <Code block>{pretty}</Code>;
  }

  return <SourceView value={value} />;
}

function BinaryPreview({
  mediaType,
  blob,
}: {
  mediaType: MediaType;
  blob: BlobRef;
}) {
  const bytes = useQuery({
    queryKey: blobKeys.file(blob.hash),
    queryFn: () => api.blobUrl(blob.hash),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const size =
    blob.size < 1024 * 1024
      ? `${Math.max(1, Math.round(blob.size / 1024))} KB`
      : `${(blob.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        {mediaType}, {size}
      </Text>
      {bytes.isPending && <Loader size="sm" aria-label="Loading the file" />}
      {bytes.isError && (
        <Alert color="red">
          Could not load the file: {bytes.error.message}
        </Alert>
      )}
      {bytes.data && mediaKindOf(mediaType) === "image" && (
        <Image
          src={bytes.data}
          alt="Preview"
          maw="100%"
          mah="60vh"
          fit="contain"
          radius="sm"
        />
      )}
      {bytes.data && mediaKindOf(mediaType) === "audio" && (
        <audio controls src={bytes.data} aria-label="Play the file" />
      )}
      <DerivedTextField hash={blob.hash} />
    </Stack>
  );
}

export function DerivedTextField({ hash }: { hash: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: blobKeys.text(hash),
    queryFn: () => api.getDerivedText(hash),
    refetchInterval: (q) => (q.state.data?.state === "pending" ? 2000 : false),
  });
  const describer = useQuery({
    queryKey: blobKeys.describer(),
    queryFn: api.getMediaDescriber,
  });
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const refresh = (value: DerivedText) => {
    queryClient.setQueryData(blobKeys.text(hash), value);
    setDraft(undefined);
  };
  const save = useMutation({
    mutationFn: (text: string) => api.setDerivedText(hash, text),
    onSuccess: refresh,
    onError: showError("Could not save the text"),
  });
  const retry = useMutation({
    mutationFn: () => api.describeFile(hash),
    onSuccess: refresh,
    onError: showError("Could not start the description"),
  });

  if (query.isPending)
    return <Loader size="xs" aria-label="Loading the text" />;

  if (query.isError) {
    return <Alert color="red">{query.error.message}</Alert>;
  }

  const { text, state } = query.data;
  const shown = draft ?? text;
  const on = describer.data?.enabled ?? false;
  const status: Record<string, string> = {
    none: "No text yet.",
    pending: "Writing a description…",
    generated: "Written by the Media Describer.",
    edited: "Edited by you.",
    failed: text === "" ? "Not generated." : "The last attempt failed.",
  };

  return (
    <Stack gap={4}>
      <Textarea
        label="Text for search and for models that cannot see or hear this file"
        autosize
        minRows={2}
        maxRows={10}
        value={shown}
        onChange={(e) => setDraft(e.currentTarget.value)}
        disabled={state === "pending"}
      />
      <Group gap="xs">
        <Text size="xs" c={state === "failed" ? "red" : "dimmed"}>
          {status[state]}
        </Text>
        {state === "pending" && <Loader size="xs" />}
        {draft !== undefined && draft !== text && (
          <Button
            size="xs"
            loading={save.isPending}
            onClick={() => save.mutate(draft)}
          >
            Save text
          </Button>
        )}
        {state !== "pending" && (
          <Button
            size="xs"
            variant="default"
            disabled={!on}
            loading={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {state === "failed"
              ? "Retry"
              : text === ""
                ? "Generate"
                : "Write again"}
          </Button>
        )}
        {!on && state !== "pending" && (
          <Text size="xs" c="dimmed">
            Choose a Media describer model in Settings to generate it.
          </Text>
        )}
      </Group>
    </Stack>
  );
}

function SourceView({ value }: { value: string }) {
  return (
    <Paper p="sm">
      <Text size="sm" ff="monospace" className={utils.preWrap}>
        {value === "" ? (
          <Text span c="dimmed">
            (empty)
          </Text>
        ) : (
          value
        )}
      </Text>
    </Paper>
  );
}

export function TypeBadge({ mediaType }: { mediaType?: MediaType }) {
  if (!mediaType) return null;

  return (
    <Badge color="gray">
      {FILE_TYPES.find((t) => t.value === mediaType)?.label ?? mediaType}
    </Badge>
  );
}

export function useRefresh(source: ExplorerSource) {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries({ queryKey: source.keys.all });
}

export function VersionsModal({
  source,
  file,
  readOnly,
  onClose,
}: {
  source: ExplorerSource;
  file: FileDetail;
  readOnly: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh(source);
  const latest = file.versions.at(-1);

  return (
    <GenericVersionsModal
      title={`Versions of ${file.key}`}
      versions={file.versions}
      listWidth={240}
      bodyHeight="55vh"
      label={(v) => (
        <Group gap={4}>
          <Text size="sm">#{v.seq}</Text>
          <Badge color={v.by === "user" ? "blue" : "grape"}>
            {v.by === "user" ? "You" : "Model"}
          </Badge>
          {v.deleted && <Badge color="red">deleted</Badge>}
        </Group>
      )}
      note={(v) => (
        <Group gap="xs">
          <TypeBadge {...(v.mediaType ? { mediaType: v.mediaType } : {})} />
          {v.deleted && (
            <Text size="sm" c="dimmed">
              Deleted here; the value it had is shown.
            </Text>
          )}
        </Group>
      )}
      body={(v) => (
        <ValueView
          {...(v.mediaType ? { mediaType: v.mediaType } : {})}
          value={v.value}
          blob={v.blob}
        />
      )}
      restore={
        readOnly
          ? undefined
          : {
              run: (seq) => source.restore(file.key, seq),
              afterRestore: refresh,
              isCurrent: (v) => v.seq === latest?.seq && !file.deleted,
              canRestore: (v) => !v.deleted,
            }
      }
      onClose={onClose}
    />
  );
}

export function confirmDelete(what: string, onConfirm: () => void) {
  modals.openConfirmModal({
    title: `Delete ${what}?`,
    children: (
      <Text size="sm">
        Its earlier versions are kept, and it can be restored from them.
      </Text>
    ),
    labels: { confirm: "Delete", cancel: "Cancel" },
    confirmProps: { color: "red" },
    onConfirm,
  });
}
