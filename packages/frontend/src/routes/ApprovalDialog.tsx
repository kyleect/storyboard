import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
  NOTE_CHOICES,
  pointerSteps,
  selectAll,
  type ApprovalAnswer,
  type ApprovalChoice,
  type ApprovalRequest,
  type ChangeRecord,
  type Review,
  type Selection,
} from "@harness/core";

const CHOICES: { choice: ApprovalChoice; label: string; color?: string }[] = [
  { choice: "once", label: "Allow once" },
  { choice: "session", label: "Allow for this session" },
  { choice: "always", label: "Always allow this tool" },
  { choice: "deny", label: "Deny", color: "red" },
];

/**
 * Asks whether a tool call may run (tools design 6.5). Closing it leaves the
 * request open; the run keeps waiting until it is answered. A note typed in
 * the box goes with Allow once or Deny; the other two choices are disabled
 * while there is one (approval notes design, D2 and D6). A tool that always
 * asks offers only Allow once and Deny; one the agent's own setting makes ask
 * has no "Always allow this tool", which sets the global setting the agent's
 * overrides (agent tool approval design, Q9).
 */
export function ApprovalDialog({
  request,
  opened,
  busy,
  onClose,
  onAnswer,
  onCheck,
  onRefresh,
}: {
  request: ApprovalRequest;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
  /** For a request with a review: the problems with a selection. */
  onCheck?: (
    selection: Selection,
  ) => Promise<{ errors: string[]; stale: boolean }>;
  /** For a request with a review: the changes worked out again. */
  onRefresh?: () => Promise<ApprovalRequest>;
}) {
  if (request.review) {
    return (
      <ChangesDialog
        request={request}
        review={request.review}
        opened={opened}
        busy={busy}
        onClose={onClose}
        onAnswer={onAnswer}
        onCheck={onCheck}
        onRefresh={onRefresh}
      />
    );
  }
  return (
    <ArgumentsDialog
      request={request}
      opened={opened}
      busy={busy}
      onClose={onClose}
      onAnswer={onAnswer}
    />
  );
}

/** The prompt for a call shown by its arguments. */
function ArgumentsDialog({
  request,
  opened,
  busy,
  onClose,
  onAnswer,
}: {
  request: ApprovalRequest;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
}) {
  const [note, setNote] = useState("");
  const text = note.trim();
  // A tool that always asks can only be allowed once or denied.
  const choices = request.alwaysAsks
    ? CHOICES.filter((c) => c.choice === "once" || c.choice === "deny")
    : request.agentSetting
      ? CHOICES.filter((c) => c.choice !== "always")
      : CHOICES;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Allow this tool call?"
      size="lg"
    >
      <Stack gap="sm">
        <Text size="sm">
          The model wants to run <Code>{request.name}</Code> with:
        </Text>
        <Code block>{JSON.stringify(request.arguments, null, 2)}</Code>
        {request.agentSetting && (
          <Text size="xs" c="dimmed">
            This agent asks before using this tool, so it cannot be always
            allowed here.
          </Text>
        )}
        <Textarea
          autosize
          minRows={2}
          placeholder="Note for the model (optional)"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          {choices.map((c) => {
            const takesNote = NOTE_CHOICES.includes(c.choice);
            const blocked = !takesNote && text !== "";
            const button = (
              <Button
                key={c.choice}
                variant={c.choice === "once" ? "filled" : "light"}
                {...(c.color ? { color: c.color } : {})}
                disabled={busy || blocked}
                onClick={() =>
                  onAnswer(
                    takesNote && text
                      ? { choice: c.choice, note: text }
                      : { choice: c.choice },
                  )
                }
              >
                {c.label}
              </Button>
            );
            return blocked ? (
              <Tooltip key={c.choice} label="Clear the note to use this">
                {/* A disabled button gets no pointer events. */}
                <span>{button}</span>
              </Tooltip>
            ) : (
              button
            );
          })}
        </Group>
      </Stack>
    </Modal>
  );
}

// ---- Changes (schemas and data design, decisions 30 to 35) -----------------

/** A path as the prompt shows it: its steps, or "the whole value". */
const pathText = (path: string) => {
  const steps = pointerSteps(path);
  return steps.length === 0 ? "the whole value" : steps.join(" › ");
};

const short = (v: unknown) => {
  const text = JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

const KIND_COLOR = { added: "green", removed: "red", changed: "blue" } as const;

function ChangeLine({ change }: { change: ChangeRecord }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Badge size="xs" variant="light" color={KIND_COLOR[change.kind]}>
        {change.kind}
      </Badge>
      <Code>{pathText(change.path)}</Code>
      <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>
        {change.kind === "added"
          ? short(change.after)
          : change.kind === "removed"
            ? short(change.before)
            : `${short(change.before)} → ${short(change.after)}`}
      </Text>
    </Group>
  );
}

const isAll = (review: Review, selection: Selection) =>
  review.items.every(
    (i) => (selection[i.key]?.length ?? -1) === i.changes.length,
  );

/**
 * The prompt for a call that describes its changes: each change has a tick
 * (decision 32). Approve selected applies the ticked ones, Approve all every
 * one, Deny all none; session and always apply every one too (decisions 34,
 * 35a). A selection the schema refuses cannot be approved (33). When the
 * data changed meanwhile, the changes can be worked out again or the call
 * rejected (30).
 */
function ChangesDialog({
  request,
  review: shown,
  opened,
  busy,
  onClose,
  onAnswer,
  onCheck,
  onRefresh,
}: {
  request: ApprovalRequest;
  review: Review;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
  onCheck?:
    | ((selection: Selection) => Promise<{ errors: string[]; stale: boolean }>)
    | undefined;
  onRefresh?: (() => Promise<ApprovalRequest>) | undefined;
}) {
  const [review, setReview] = useState(shown);
  const [selection, setSelection] = useState<Selection>(() => selectAll(shown));
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const text = note.trim();

  useEffect(() => {
    if (!onCheck) return;
    let current = true;
    const timer = setTimeout(() => {
      onCheck(selection).then(
        (r) => {
          if (!current) return;
          setProblems(r.errors);
          setStale(r.stale);
        },
        () => {},
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [onCheck, selection]);

  const toggle = (key: string, path: string, on: boolean) =>
    setSelection((prev) => {
      const paths = new Set(prev[key] ?? []);
      if (on) paths.add(path);
      else paths.delete(path);
      return { ...prev, [key]: [...paths] };
    });

  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      const next = await onRefresh();
      if (next.review) {
        setReview(next.review);
        setSelection(selectAll(next.review));
        setStale(false);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const withNote = (choice: ApprovalChoice): ApprovalAnswer =>
    NOTE_CHOICES.includes(choice) && text ? { choice, note: text } : { choice };
  const blocked = busy || stale || refreshing;
  const others: { choice: ApprovalChoice; label: string }[] = [
    ...(request.alwaysAsks
      ? []
      : [{ choice: "session" as const, label: "Allow for this session" }]),
    ...(request.alwaysAsks || request.agentSetting
      ? []
      : [{ choice: "always" as const, label: "Always allow this tool" }]),
  ];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Approve these changes?"
      size="lg"
    >
      <Stack gap="sm">
        <Text size="sm">
          The model wants to run <Code>{request.name}</Code>. Untick a change to
          leave it out.
        </Text>
        {stale && (
          <Alert color="yellow" title="The data changed since this was asked">
            <Group gap="xs">
              <Button
                size="xs"
                onClick={() => void refresh()}
                loading={refreshing}
              >
                Refresh
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                disabled={busy}
                onClick={() => onAnswer(withNote("deny"))}
              >
                Reject
              </Button>
            </Group>
          </Alert>
        )}
        {review.items.map((item) => (
          <Stack key={item.key} gap={6}>
            <Text fw={500} size="sm">
              {item.label}
            </Text>
            {item.schema && (
              <Stack gap={4}>
                <Text size="xs" c="dimmed">
                  Schema version {item.schema.fromVersion} →{" "}
                  {item.schema.toVersion}
                </Text>
                {item.schema.changes.map((c) => (
                  <ChangeLine key={c.path} change={c} />
                ))}
              </Stack>
            )}
            {item.showValue && (
              <Code block>{JSON.stringify(item.after, null, 2)}</Code>
            )}
            {item.changes.length === 0 ? (
              <Text size="xs" c="dimmed">
                No changes.
              </Text>
            ) : (
              item.changes.map((c) => (
                <Checkbox
                  key={c.path}
                  checked={(selection[item.key] ?? []).includes(c.path)}
                  onChange={(e) =>
                    toggle(item.key, c.path, e.currentTarget.checked)
                  }
                  label={<ChangeLine change={c} />}
                  aria-label={`${item.label}: ${pathText(c.path)}`}
                />
              ))
            )}
          </Stack>
        ))}
        {problems.length > 0 && (
          <Alert color="red" title="These changes can't be applied together">
            <Stack gap={2}>
              {problems.map((p) => (
                <Text key={p} size="xs" style={{ whiteSpace: "pre-wrap" }}>
                  {p}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <Textarea
          autosize
          minRows={2}
          placeholder="Note for the model (optional)"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          <Button
            disabled={blocked || problems.length > 0}
            onClick={() =>
              onAnswer({
                ...withNote("once"),
                ...(isAll(review, selection) ? {} : { selection }),
              })
            }
          >
            Approve selected
          </Button>
          <Button
            variant="light"
            disabled={blocked}
            onClick={() => onAnswer(withNote("once"))}
          >
            Approve all
          </Button>
          {others.map((c) => (
            <Tooltip
              key={c.choice}
              label="Clear the note to use this"
              disabled={text === ""}
            >
              <span>
                <Button
                  variant="light"
                  disabled={blocked || text !== ""}
                  onClick={() => onAnswer({ choice: c.choice })}
                >
                  {c.label}
                </Button>
              </span>
            </Tooltip>
          ))}
          <Button
            variant="light"
            color="red"
            disabled={busy}
            onClick={() => onAnswer(withNote("deny"))}
          >
            Deny all
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
