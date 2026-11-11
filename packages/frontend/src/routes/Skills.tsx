import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  NavLink,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  api,
  type SkillContent,
  type SkillDetail,
  type SkillOwner,
  type SkillVersion,
} from "../api";
import { projectKeys, skillKeys } from "../queries";
import { showError } from "./SessionActions";

/*
 * Skills (skills design, decisions 26 and 27): a panel per scope with the
 * list on the left and the selected skill on the right, as for agents. The
 * global and project pages use it, and so does the agent's page.
 */

/** The most the description may hold (skills design, decision 23). */
const MAX_DESCRIPTION = 1024;

const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "");

/** Refreshes a scope's lists and open skills after a change. */
function useRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: skillKeys.all });
  };
}

/** A skill that comes with the app (schemas and data design, decision 51). */
function BuiltinBadge() {
  return (
    <Badge size="xs" variant="light" color="blue">
      built-in
    </Badge>
  );
}

function DeletedBadge() {
  return (
    <Badge size="xs" variant="light" color="red">
      deleted
    </Badge>
  );
}

/** Text in a box, keeping line breaks. */
function TextBox({ value }: { value: string }) {
  return (
    <Paper p="sm" withBorder>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
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

/** One version's content, read-only. */
function VersionContent({ v }: { v: SkillContent & { name: string } }) {
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {v.displayName}
      </Text>
      <Text size="xs" c="dimmed" ff="monospace">
        {v.name}
      </Text>
      <Text size="xs" c="dimmed">
        Description
      </Text>
      <TextBox value={v.description} />
      <Text size="xs" c="dimmed">
        Body
      </Text>
      <TextBox value={v.body} />
    </Stack>
  );
}

/** A skill's versions; one can be made current (decision 16). */
function VersionsModal({
  skill,
  readOnly,
  onClose,
}: {
  skill: SkillDetail;
  readOnly: boolean;
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const newestFirst = [...skill.versions].reverse();
  const [picked, setPicked] = useState<SkillVersion | undefined>(
    newestFirst[0],
  );
  const restore = useMutation({
    mutationFn: (seq: number) => api.restoreSkill(skill.id, seq),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: showError("Could not restore the version"),
  });
  const isCurrent = picked?.seq === skill.version && !skill.deleted;

  return (
    <Modal
      opened
      onClose={onClose}
      size="xl"
      title={`Versions of ${skill.displayName}`}
    >
      <Group align="flex-start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah="60vh" w={220} style={{ flexShrink: 0 }}>
          {newestFirst.map((v) => (
            <NavLink
              key={v.seq}
              active={picked?.seq === v.seq}
              onClick={() => setPicked(v)}
              label={
                <Group gap={4}>
                  <Text size="sm">v{v.seq}</Text>
                  {v.deleted && <DeletedBadge />}
                </Group>
              }
              description={when(v.createdAt)}
            />
          ))}
        </ScrollArea.Autosize>
        {picked && (
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {picked.deleted
                  ? "Deleted here; the content it had is shown."
                  : ""}
              </Text>
              {!readOnly && (
                <Button
                  size="xs"
                  disabled={picked.deleted || isCurrent}
                  loading={restore.isPending}
                  onClick={() => restore.mutate(picked.seq)}
                >
                  {isCurrent ? "Current" : "Make current"}
                </Button>
              )}
            </Group>
            <ScrollArea.Autosize mah="55vh">
              <VersionContent v={picked} />
            </ScrollArea.Autosize>
          </Stack>
        )}
      </Group>
    </Modal>
  );
}

type Mode = { mode: "view" } | { mode: "edit" } | { mode: "new" };

/**
 * An owner's skills: list on the left, the selected skill on the right.
 * `readOnly` with a reason when changes are not allowed.
 */
export function SkillsPanel({
  owner,
  readOnly,
}: {
  owner: SkillOwner;
  readOnly?: string | undefined;
}) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ mode: "view" });
  const list = useQuery({
    queryKey: skillKeys.list(owner, showDeleted),
    queryFn: () => api.listSkills(owner, showDeleted),
  });
  // Inside an agent's page the list gets less room.
  const listWidth = owner.scope === "agent" ? 200 : 260;

  return (
    <Group align="flex-start" wrap="nowrap" gap="md">
      <Stack gap="xs" w={listWidth} style={{ flexShrink: 0 }}>
        {readOnly && (
          <Text size="sm" c="dimmed">
            {readOnly}
          </Text>
        )}
        <Switch
          size="xs"
          label="Show deleted"
          checked={showDeleted}
          onChange={(e) => setShowDeleted(e.currentTarget.checked)}
        />
        {!readOnly && (
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              onClick={() => {
                setSelected(null);
                setMode({ mode: "new" });
              }}
            >
              New skill
            </Button>
          </Group>
        )}
        {list.isPending && <Loader size="sm" />}
        {list.isError && <Alert color="red">{list.error.message}</Alert>}
        {list.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No skills.
          </Text>
        )}
        <Stack gap={0}>
          {list.data?.map((s) => (
            <NavLink
              key={s.id}
              active={selected === s.id && mode.mode !== "new"}
              onClick={() => {
                setSelected(s.id);
                setMode({ mode: "view" });
              }}
              label={
                <Text
                  size="sm"
                  {...(s.deleted ? { c: "dimmed" } : {})}
                  truncate
                >
                  {s.displayName}
                </Text>
              }
              description={s.name}
              rightSection={
                s.deleted ? (
                  <DeletedBadge />
                ) : s.scope === "builtin" ? (
                  <BuiltinBadge />
                ) : undefined
              }
            />
          ))}
        </Stack>
      </Stack>
      <Stack style={{ flex: 1, minWidth: 0 }}>
        {mode.mode === "new" && !readOnly ? (
          <SkillEditor
            owner={owner}
            onSaved={(id) => {
              setSelected(id);
              setMode({ mode: "view" });
            }}
            onCancel={() => setMode({ mode: "view" })}
          />
        ) : selected ? (
          <SkillView
            key={selected}
            owner={owner}
            skillId={selected}
            readOnly={!!readOnly}
            editing={mode.mode === "edit"}
            onEdit={() => setMode({ mode: "edit" })}
            onDone={() => setMode({ mode: "view" })}
            onGone={() => setSelected(null)}
          />
        ) : (
          <Text size="sm" c="dimmed">
            Pick a skill on the left.
          </Text>
        )}
      </Stack>
    </Group>
  );
}

function SkillView({
  owner,
  skillId,
  readOnly,
  editing,
  onEdit,
  onDone,
  onGone,
}: {
  owner: SkillOwner;
  skillId: string;
  readOnly: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onGone: () => void;
}) {
  const refresh = useRefresh();
  const [versions, setVersions] = useState(false);
  const skill = useQuery({
    queryKey: skillKeys.detail(skillId),
    queryFn: () => api.getSkill(skillId),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSkill(skillId),
    onSuccess: refresh,
    onError: showError("Could not delete the skill"),
  });

  if (skill.isPending) return <Loader size="sm" />;
  if (skill.isError) {
    return (
      <Alert color="red" withCloseButton onClose={onGone}>
        {skill.error.message}
      </Alert>
    );
  }
  const s = skill.data;
  // Built-in skills are read-only (decision 51).
  const fixed = readOnly || s.scope === "builtin";

  if (editing && !fixed && !s.deleted) {
    return (
      <SkillEditor
        owner={owner}
        existing={s}
        onSaved={onDone}
        onCancel={onDone}
      />
    );
  }

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Title order={5} style={{ wordBreak: "break-word" }}>
            {s.displayName}
          </Title>
          <Badge size="xs" variant="light" color="gray">
            v{s.version}
          </Badge>
          {s.deleted && <DeletedBadge />}
          {s.scope === "builtin" && <BuiltinBadge />}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button size="xs" variant="default" onClick={() => setVersions(true)}>
            Versions ({s.versions.length})
          </Button>
          {!fixed && !s.deleted && (
            <>
              <Button size="xs" variant="light" onClick={onEdit}>
                Edit
              </Button>
              <Button
                size="xs"
                variant="light"
                color="red"
                loading={remove.isPending}
                onClick={() =>
                  modals.openConfirmModal({
                    title: `Delete “${s.displayName}”?`,
                    children: (
                      <Text size="sm">
                        It is no longer available to the model. Its versions are
                        kept, and it can be restored from them.
                      </Text>
                    ),
                    labels: { confirm: "Delete", cancel: "Cancel" },
                    confirmProps: { color: "red" },
                    onConfirm: () => remove.mutate(),
                  })
                }
              >
                Delete
              </Button>
            </>
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        <Text span ff="monospace">
          {s.name}
        </Text>
        {" · "}
        {s.deleted ? "Deleted" : "Changed"} {when(s.updatedAt)}
        {s.deleted && ". Open Versions to restore it."}
      </Text>
      <Text size="xs" c="dimmed">
        Description
      </Text>
      <TextBox value={s.description} />
      <Text size="xs" c="dimmed">
        Body
      </Text>
      <TextBox value={s.body} />
      {versions && (
        <VersionsModal
          skill={s}
          readOnly={fixed}
          onClose={() => setVersions(false)}
        />
      )}
    </Stack>
  );
}

/** Creates a skill, or saves `existing` as a new version. */
function SkillEditor({
  owner,
  existing,
  onSaved,
  onCancel,
}: {
  owner: SkillOwner;
  existing?: SkillDetail;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const refresh = useRefresh();
  const [displayName, setDisplayName] = useState(existing?.displayName ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [body, setBody] = useState(existing?.body ?? "");

  const save = useMutation({
    mutationFn: () => {
      const c: SkillContent = { displayName, description, body };
      return existing
        ? api.saveSkill(existing.id, c)
        : api.createSkill(owner, c);
    },
    onSuccess: async (saved) => {
      await refresh();
      onSaved(saved.id);
    },
    onError: showError("Could not save the skill"),
  });

  return (
    <Stack gap="xs">
      <TextInput
        label="Name"
        description="The model uses this name in lowercase with hyphens: “My Skill” becomes my-skill. Unique among this scope's skills."
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
      />
      <Textarea
        label="Description"
        description="Says what the skill is for and when to use it. The model chooses skills by this."
        autosize
        minRows={2}
        maxRows={8}
        maxLength={MAX_DESCRIPTION}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Text size="xs" c="dimmed">
        {description.length} of {MAX_DESCRIPTION} characters
      </Text>
      <Textarea
        label="Body"
        description="What the model reads when it loads the skill."
        autosize
        minRows={8}
        maxRows={30}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          size="xs"
          disabled={displayName.trim() === "" || description.trim() === ""}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

/** Global skills (decision 26). */
export function GlobalSkillsPage() {
  return (
    <Stack gap="md">
      <Title order={3}>Skills</Title>
      <Text size="sm" c="dimmed">
        Global: every session can use these.
      </Text>
      <SkillsPanel owner={{ scope: "global" }} />
    </Stack>
  );
}

/** A project's skills (decision 26). */
export function ProjectSkillsPage({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => api.getProject(projectId),
  });
  if (project.isPending) return <Loader />;
  if (project.isError)
    return <Alert color="red">{project.error.message}</Alert>;
  const trashed = project.data.trashed_at !== null;
  return (
    <Stack gap="md">
      <Title order={3}>Skills</Title>
      <Text size="sm" c="dimmed">
        Project{" "}
        <Anchor
          renderRoot={(props) => (
            <Link {...props} to="/projects/$projectId" params={{ projectId }} />
          )}
        >
          {project.data.name}
        </Anchor>
        : sessions in this project can use these, as well as the global ones.
      </Text>
      <SkillsPanel
        owner={{ scope: "project", id: projectId }}
        readOnly={
          trashed
            ? "The project is in the trash, so these can be read but not changed."
            : undefined
        }
      />
    </Stack>
  );
}
