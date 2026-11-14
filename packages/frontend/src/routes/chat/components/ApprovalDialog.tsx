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
import utils from "../../../styles/utilities.module.css";
import { useEffect, useState } from "react";
import {
  COMMENT_CHOICES,
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

const choiceLabel = (
  choice: { choice: ApprovalChoice; label: string },
  request: ApprovalRequest,
): string =>
  request.subject
    ? choice.choice === "session"
      ? `Allow for this session in ${request.subject.label}`
      : choice.choice === "always"
        ? `Always allow this tool in ${request.subject.label}`
        : choice.label
    : choice.label;

export function ApprovalDialog({
  request,
  opened,
  busy,
  onClose,
  onAnswer,
  onCheck,
  onRefresh,
  from,
}: {
  request: ApprovalRequest;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
  from?: string;
  onCheck?: (
    selection: Selection,
  ) => Promise<{ errors: string[]; stale: boolean }>;
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
        from={from}
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
      from={from}
    />
  );
}

function FromSubagent({ name }: { name: string }) {
  return (
    <Group gap="xs">
      <Badge color="teal">subagent</Badge>
      <Text size="sm" fw={500}>
        {name} is asking
      </Text>
    </Group>
  );
}

function ArgumentsDialog({
  request,
  opened,
  busy,
  onClose,
  onAnswer,
  from,
}: {
  request: ApprovalRequest;
  opened: boolean;
  busy: boolean;
  onClose: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
  from: string | undefined;
}) {
  const [comment, setComment] = useState("");
  const text = comment.trim();
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
        {from && <FromSubagent name={from} />}
        <Text size="sm">
          The model wants to run <Code>{request.name}</Code>
          {request.subject
            ? ` in the workspace ${request.subject.label}`
            : ""}{" "}
          with:
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
          placeholder="Comment for the model (optional)"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          {choices.map((c) => {
            const takesComment = COMMENT_CHOICES.includes(c.choice);
            const blocked = !takesComment && text !== "";
            const button = (
              <Button
                key={c.choice}
                variant={c.choice === "once" ? "filled" : "light"}
                {...(c.color ? { color: c.color } : {})}
                disabled={busy || blocked}
                onClick={() =>
                  onAnswer(
                    takesComment && text
                      ? { choice: c.choice, decisionComment: text }
                      : { choice: c.choice },
                  )
                }
              >
                {choiceLabel(c, request)}
              </Button>
            );

            return blocked ? (
              <Tooltip key={c.choice} label="Clear the comment to use this">
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
      <Badge color={KIND_COLOR[change.kind]}>{change.kind}</Badge>
      <Code>{pathText(change.path)}</Code>
      <Text size="xs" c="dimmed" className={utils.breakWord}>
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

function ChangesDialog({
  request,
  review: shown,
  opened,
  busy,
  onClose,
  onAnswer,
  onCheck,
  onRefresh,
  from,
}: {
  request: ApprovalRequest;
  review: Review;
  from: string | undefined;
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
  const [comment, setComment] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const text = comment.trim();

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
    COMMENT_CHOICES.includes(choice) && text
      ? { choice, decisionComment: text }
      : { choice };
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
        {from && <FromSubagent name={from} />}
        <Text size="sm">
          The model wants to run <Code>{request.name}</Code>
          {request.subject ? ` in the workspace ${request.subject.label}` : ""}.
          Untick a change to leave it out.
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
                <Text key={p} size="xs" className={utils.preWrap}>
                  {p}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <Textarea
          autosize
          minRows={2}
          placeholder="Comment for the model (optional)"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
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
              label="Clear the comment to use this"
              disabled={text === ""}
            >
              <span>
                <Button
                  variant="light"
                  disabled={blocked || text !== ""}
                  onClick={() => onAnswer({ choice: c.choice })}
                >
                  {choiceLabel(c, request)}
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
