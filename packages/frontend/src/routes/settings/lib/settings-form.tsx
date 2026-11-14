import { useForm, type UseFormInput } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  api,
  type Settings as SettingsShape,
  type SettingsView,
} from "../../../api";
import { settingsKeys } from "../../../queries";

export const MODEL_KEYS = [
  "model",
  "reasoningEffort",
  "embeddingModel",
] as const;
export const SERVER_KEYS = ["llamaServerUrl", "port"] as const;
export const PROMPT_KEYS = ["systemPrompt"] as const;
export const INSTRUCTION_KEYS = [
  "skillsInstruction",
  "toolsInstruction",
  "schemasInstruction",
  "dataInstruction",
  "agentsInstruction",
  "workspacesInstruction",
  "filesInstruction",
] as const;
export const TITLE_KEYS = [
  "autoRename",
  "autoRenameSource",
  "titleModel",
  "titlePrompt",
] as const;
export const SUBAGENT_KEYS = [
  "childReminders",
  "childPrompt",
  "subagentMessageLabel",
  "subagentDepth",
] as const;
export const LIMIT_KEYS = [
  "loopLimit",
  "copyLimit",
  "workspaceReadCap",
  "skillFileMaxMib",
  "skillMaxMib",
  "skillMaxFiles",
] as const;
export const EDITING_KEYS = ["editMode", "answerAfterEdit"] as const;
export const MEDIA_KEYS = ["inlineMediaCap", "keepMediaInline"] as const;
export const DESCRIBER_KEYS = [
  "mediaDescriberAgent",
  "mediaDescriberModel",
] as const;
export const TRASH_KEYS = ["trashRetentionDays"] as const;
export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (view: SettingsView) => {
      queryClient.setQueryData(settingsKeys.all, view);
      notifications.show({ color: "green", message: "Settings saved" });
    },
    onError: (err: Error) =>
      notifications.show({
        color: "red",
        title: "Could not save",
        message: err.message,
      }),
  });
}
export function envNoteFor(view: SettingsView) {
  const env = view.overriddenByEnv;
  return (key: keyof SettingsShape) =>
    env[key] ? `Overridden by the ${env[key]} environment variable` : undefined;
}
export function useSettingsFields<K extends keyof SettingsShape>(
  view: SettingsView,
  keys: readonly K[],
  validate: NonNullable<UseFormInput<Pick<SettingsShape, K>>["validate"]> = {},
) {
  const pick = () =>
    Object.fromEntries(keys.map((k) => [k, view.effective[k]])) as Pick<
      SettingsShape,
      K
    >;
  const form = useForm<Pick<SettingsShape, K>>({
    initialValues: pick(),
    validate,
  });

  const filled = useRef(view);
  useEffect(() => {
    if (filled.current === view) return;
    filled.current = view;
    const values = pick();
    form.setValues(values);
    form.resetDirty(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  return {
    form,
    env: view.overriddenByEnv,
    envNote: envNoteFor(view),
  };
}
export function useSettingsForm<K extends keyof SettingsShape>(
  view: SettingsView,
  keys: readonly K[],
  validate?: NonNullable<UseFormInput<Pick<SettingsShape, K>>["validate"]>,
) {
  const save = useSaveSettings();
  return { ...useSettingsFields(view, keys, validate), save };
}
