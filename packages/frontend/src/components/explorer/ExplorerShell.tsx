import { Box, Text, ThemeIcon, Stack, Flex, Group } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { ProjectColor } from "@harness/core";
import { useRef, useState, type ReactNode } from "react";
import { clampWidth } from "../../lib/explorer";
import { UnreadDot } from "../UnreadDot";

const BORDER = "var(--mantine-color-default-border)";
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
      bd={`1px solid ${BORDER}`}
      bdrs="var(--mantine-radius-sm)"
      bg="var(--mantine-color-body)"
      style={{ overflow: "hidden" }}
    >
      <Flex flex={1} mih={0}>
        {!hideSidebar && (
          <>
            <Stack gap={0} mih={0} bg={CHROME} style={{ width, flexShrink: 0 }}>
              {sidebar}
            </Stack>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={resizeLabel}
              aria-valuenow={width}
              tabIndex={0}
              style={{
                width: 5,
                flexShrink: 0,
                cursor: "col-resize",
                background: BORDER,
                touchAction: "none",
              }}
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
            style={{
              overflowX: "auto",
              flexShrink: 0,
              borderBottom: `1px solid ${BORDER}`,
            }}
          >
            {leading}
            {tabs.map((t) => {
              const isActive = t.id === active;
              return (
                <div
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 8px 0 10px",
                    flexShrink: 0,
                    maxWidth: 240,
                    cursor: "pointer",
                    fontSize: 13,
                    fontStyle: t.transient ? "italic" : undefined,
                    borderRight: `1px solid ${BORDER}`,
                    boxShadow:
                      over === t.id && dragged !== t.id
                        ? "inset 3px 0 0 var(--mantine-primary-color-filled)"
                        : undefined,
                    borderTop: `2px solid ${isActive ? (t.iconColor ? `var(--mantine-color-${t.iconColor}-filled)` : "var(--mantine-primary-color-filled)") : "transparent"}`,
                    background: isActive
                      ? "var(--mantine-color-body)"
                      : undefined,
                    color: isActive ? undefined : "var(--mantine-color-dimmed)",
                  }}
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
                    <span
                      style={{
                        flexShrink: 0,
                        maxWidth: 110,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        opacity: 0.7,
                      }}
                    >
                      {t.prefix} ›
                    </span>
                  )}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.label}
                  </span>
                  {t.unread && <UnreadDot />}
                  <button
                    type="button"
                    aria-label={`Close ${t.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestClose(t.id);
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                    }}
                  >
                    {t.dirty ? (
                      <span
                        role="img"
                        aria-label="Unsaved changes"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "currentColor",
                        }}
                      />
                    ) : (
                      <IconX size={14} />
                    )}
                  </button>
                </div>
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
          style={{ flexShrink: 0, borderTop: `1px solid ${BORDER}` }}
        >
          <Text size="xs" c="dimmed" truncate>
            {statusLeft}
          </Text>
          <Flex gap="sm" style={{ flexShrink: 0 }}>
            {statusRight}
          </Flex>
        </Group>
      )}
    </Stack>
  );
}
