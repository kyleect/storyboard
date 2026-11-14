import { Alert, Button, NumberInput, Stack, Textarea } from "@mantine/core";
import { COPY_LIMIT_MAX } from "@harness/core";
import { type SettingsView } from "../../../api";
import {
  SUBAGENT_KEYS,
  LIMIT_KEYS,
  useSettingsForm,
} from "../lib/settings-form";

export function Subagents({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, SUBAGENT_KEYS, {
    childReminders: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
    subagentDepth: (v) =>
      Number.isInteger(v) && v >= 0 ? null : "A whole number, 0 or more",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <NumberInput
          label="Subagent depth"
          description={
            envNote("subagentDepth") ??
            "How many levels deep an agent can start subagents. 0 turns subagents off; 1 lets only the top-level agent start them."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.subagentDepth}
          {...form.getInputProps("subagentDepth")}
        />
        <NumberInput
          label="Reminders"
          description={
            envNote("childReminders") ??
            "How many times a subagent that stops without handing back is reminded to, before its last reply is taken as its result. Each reminder counts as one of its model calls. An agent can set its own."
          }
          allowDecimal={false}
          min={0}
          disabled={!!env.childReminders}
          {...form.getInputProps("childReminders")}
        />
        <Textarea
          label="Subagent line"
          description={
            envNote("childPrompt") ??
            "Added at the very end of a subagent's system message. An agent can set its own."
          }
          autosize
          minRows={3}
          disabled={!!env.childPrompt}
          {...form.getInputProps("childPrompt")}
        />
        {form.values.childPrompt.trim() === "" && (
          <Alert color="yellow" p="xs">
            Without this line, subagents might not work correctly: they may not
            know to hand back or to ask you with a form.
          </Alert>
        )}
        <Textarea
          label="Message label"
          description={
            envNote("subagentMessageLabel") ??
            "Put before a message you send to a running subagent, so it can tell your message from its task. Empty: no label."
          }
          autosize
          minRows={2}
          disabled={!!env.subagentMessageLabel}
          {...form.getInputProps("subagentMessageLabel")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
export function Limits({ view }: { view: SettingsView }) {
  const { form, save, env, envNote } = useSettingsForm(view, LIMIT_KEYS, {
    loopLimit: (v) =>
      Number.isInteger(v) && v >= 1 ? null : "A whole number, 1 or more",
    copyLimit: (v) =>
      Number.isInteger(v) && v >= 1 && v <= COPY_LIMIT_MAX
        ? null
        : `A whole number, 1 to ${COPY_LIMIT_MAX}`,
    workspaceReadCap: (v) =>
      Number.isInteger(v) && v >= 100 ? null : "A whole number, 100 or more",
    skillFileMaxMib: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 1024
        ? null
        : "A whole number, 1 to 1024",
    skillMaxMib: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 4096
        ? null
        : "A whole number, 1 to 4096",
    skillMaxFiles: (v) =>
      Number.isInteger(v) && v >= 1 && v <= 10000
        ? null
        : "A whole number, 1 to 10000",
  });

  return (
    <form onSubmit={form.onSubmit((values) => save.mutate(values))}>
      <Stack maw={480}>
        <NumberInput
          label="Loop limit"
          description={
            envNote("loopLimit") ??
            "The most model calls one run makes before it stops."
          }
          allowDecimal={false}
          min={1}
          disabled={!!env.loopLimit}
          {...form.getInputProps("loopLimit")}
        />
        <NumberInput
          label="Copy limit"
          description={
            envNote("copyLimit") ??
            `The most files one copy or move call may name, 1 to ${COPY_LIMIT_MAX}. Copying everything in a scope is not limited.`
          }
          allowDecimal={false}
          min={1}
          max={COPY_LIMIT_MAX}
          disabled={!!env.copyLimit}
          {...form.getInputProps("copyLimit")}
        />
        <NumberInput
          label="Workspace read size"
          description={
            envNote("workspaceReadCap") ??
            "The most characters of a workspace file one read returns. Longer files come back in parts: the agent reads the rest with an offset."
          }
          allowDecimal={false}
          min={100}
          disabled={!!env.workspaceReadCap}
          {...form.getInputProps("workspaceReadCap")}
        />
        <NumberInput
          label="Skill file size (MiB)"
          description={
            envNote("skillFileMaxMib") ??
            "The most one file in a skill may hold, 1 to 1024."
          }
          allowDecimal={false}
          min={1}
          max={1024}
          disabled={!!env.skillFileMaxMib}
          {...form.getInputProps("skillFileMaxMib")}
        />
        <NumberInput
          label="Skill size (MiB)"
          description={
            envNote("skillMaxMib") ??
            "The most all the files of one skill may hold together, 1 to 4096."
          }
          allowDecimal={false}
          min={1}
          max={4096}
          disabled={!!env.skillMaxMib}
          {...form.getInputProps("skillMaxMib")}
        />
        <NumberInput
          label="Files per skill"
          description={
            envNote("skillMaxFiles") ??
            "The most files one skill may have, 1 to 10000."
          }
          allowDecimal={false}
          min={1}
          max={10000}
          disabled={!!env.skillMaxFiles}
          {...form.getInputProps("skillMaxFiles")}
        />
        <Button type="submit" loading={save.isPending} w="fit-content">
          Save
        </Button>
      </Stack>
    </form>
  );
}
