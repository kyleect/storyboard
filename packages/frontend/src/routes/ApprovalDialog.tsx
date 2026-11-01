import {
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { useState } from "react";
import {
  NOTE_CHOICES,
  type ApprovalAnswer,
  type ApprovalChoice,
  type ApprovalRequest,
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
 * while there is one (approval notes design, D2 and D6).
 */
export function ApprovalDialog({
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
        <Textarea
          autosize
          minRows={2}
          placeholder="Note for the model (optional)"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          {CHOICES.map((c) => {
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
