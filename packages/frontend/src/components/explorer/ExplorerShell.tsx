import {
  ActionIcon,
  Box,
  Text,
  ThemeIcon,
  Stack,
  Flex,
  Group,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { ProjectColor } from "@harness/core";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import classes from "./ExplorerShell.module.css";
import { clampWidth } from "../../lib/explorer";
import { UnreadDot } from "../UnreadDot";

const tabColor = (color: ProjectColor | undefined) =>
  color
    ? ({
        "--tab-color": `var(--mantine-color-${color}-filled)`,
      } as CSSProperties)
    : undefined;

const CHROME =
  "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))";

export interface ShellTab {
  id: string;
  label: string;
  prefix?: string;
  title: string;
  icon: ReactNode;
  iconColor?: ProjectColor;
  transient: boolean;
  dirty: boolean;
  unread?: boolean;
}

export function ExplorerShell({
  width,
  onWidthChange,
  sidebar,
  tabs,
  active,
  onActivate,
  onKeep,
  onRequestClose,
  content,
  empty,
  statusLeft,
  statusRight,
  tabListLabel,
  resizeLabel,
  leading,
  onReorder,
  hideSidebar = false,
  hideStatus = false,
  flush = false,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  sidebar: ReactNode;
  tabs: readonly ShellTab[];
  active: string | null;
  onActivate: (id: string) => void;
  onKeep: (id: string) => void;
  onRequestClose: (id: string) => void;
  content: ReactNode;
  empty: string;
  statusLeft: string;
  statusRight: ReactNode;
  tabListLabel: string;
  resizeLabel: string;
  leading?: ReactNode;
  onReorder?: (id: string, toIndex: number) => void;
  hideSidebar?: boolean;
  hideStatus?: boolean;
  flush?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const resizeTo = (clientX: number) => {
    const left = container.current?.getBoundingClientRect().left ?? 0;

    onWidthChange(clampWidth(clientX - left));
  };

  return (
    <Stack
      ref={container}
      gap={0}
      h="100%"
      mih={0}
      {...(flush
        ? {}
        : {
            bd: "1px solid var(--mantine-color-default-border)",
            bdrs: "var(--mantine-radius-sm)",
          })}
      bg="var(--mantine-color-body)"
      className={classes.root}
    >
      <Flex flex={1} mih={0}>
        {!hideSidebar && (
          <>
            <Stack
              gap={0}
              mih={0}
              bg={CHROME} // eslint-disable-next-line no-restricted-syntax -- px from the drag handle; a rem prop would drift from the pointer at other root font sizes
              style={{ width, flexShrink: 0 }}
            >
              {sidebar}
            </Stack>

            <Box
              role="separator"
              aria-orientation="vertical"
              aria-label={resizeLabel}
              aria-valuenow={width}
              tabIndex={0}
              className={classes.separator}
              onPointerDown={(e) => {
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (dragging.current) resizeTo(e.clientX);
              }}
              onPointerUp={() => {
                dragging.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft")
                  onWidthChange(clampWidth(width - 16));

                if (e.key === "ArrowRight")
                  onWidthChange(clampWidth(width + 16));
              }}
            />
          </>
        )}

        <Stack gap={0} flex={1} miw={0}>
          <Flex
            role="tablist"
            aria-label={tabListLabel}
            mih={34}
            bg={CHROME}
            flex="none"
            className={classes.tabList}
          >
            {leading}
            {tabs.map((t) => {
              const isActive = t.id === active;

              return (
                <Box
                  key={t.id}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  title={t.title}
                  onClick={() => onActivate(t.id)}
                  onDoubleClick={() => onKeep(t.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      onRequestClose(t.id);
                    }
                  }}
                  draggable={onReorder !== undefined}
                  onDragStart={(e) => {
                    setDragged(t.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", t.label);
                  }}
                  onDragOver={(e) => {
                    if (dragged === null) return;

                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";

                    if (over !== t.id) setOver(t.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragged;

                    setDragged(null);
                    setOver(null);

                    if (from !== null && from !== t.id) {
                      onReorder?.(
                        from,
                        tabs.findIndex((x) => x.id === t.id),
                      );
                    }
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.altKey && onReorder) {
                      const at = tabs.findIndex((x) => x.id === t.id);

                      if (e.key === "ArrowLeft") {
                        e.preventDefault();
                        onReorder(t.id, at - 1);
                      } else if (e.key === "ArrowRight") {
                        e.preventDefault();
                        onReorder(t.id, at + 1);
                      }

                      return;
                    }

                    if (e.key === "Enter" || e.key === " ") onActivate(t.id);
                  }}
                  className={classes.tab}
                  mod={{
                    active: isActive,
                    transient: t.transient,
                    "drop-target": over === t.id && dragged !== t.id,
                  }}
                  style={tabColor(t.iconColor)}
                >
                  <ThemeIcon
                    size="xs"
                    variant="filled"
                    radius="xs"
                    {...(t.iconColor ? { color: t.iconColor } : {})}
                  >
                    {t.icon}
                  </ThemeIcon>
                  {t.prefix && (
                    <Text
                      span
                      inherit
                      truncate
                      flex="none"
                      maw={110}
                      opacity={0.7}
                    >
                      {t.prefix} ›
                    </Text>
                  )}
                  <Text span inherit truncate>
                    {t.label}
                  </Text>
                  {t.unread && <UnreadDot />}
                  <ActionIcon
                    variant="transparent"
                    color="inherit"
                    size={16}
                    radius={3}
                    aria-label={`Close ${t.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestClose(t.id);
                    }}
                  >
                    {t.dirty ? (
                      <Box
                        component="span"
                        role="img"
                        aria-label="Unsaved changes"
                        w={8}
                        h={8}
                        bdrs="50%"
                        bg="currentColor"
                      />
                    ) : (
                      <IconX size={14} />
                    )}
                  </ActionIcon>
                </Box>
              );
            })}
          </Flex>

          <Box flex={1} mih={0}>
            {content ?? (
              <Group gap={0} justify="center" wrap="nowrap" h="100%">
                <Text size="sm" c="dimmed">
                  {empty}
                </Text>
              </Group>
            )}
          </Box>
        </Stack>
      </Flex>

      {!hideStatus && (
        <Group
          role="status"
          px="sm"
          gap="sm"
          justify="space-between"
          wrap="nowrap"
          mih={24}
          bg={CHROME}
          flex="none"
          className={classes.status}
        >
          <Text size="xs" c="dimmed" truncate>
            {statusLeft}
          </Text>
          <Flex gap="sm" flex="none">
            {statusRight}
          </Flex>
        </Group>
      )}
    </Stack>
  );
}
