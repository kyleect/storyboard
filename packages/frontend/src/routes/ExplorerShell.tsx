import { Box, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useRef, type ReactNode } from "react";
import { clampWidth } from "../explorer";

/*
 * The frame of an editor-style explorer: a sidebar (the tree), a divider
 * that can be dragged, a strip of tabs, the active tab's content and a
 * status bar. The Files view and the Structured Data view share it; each
 * gives it the sidebar, the tabs and the content, and keeps its own state.
 */

const BORDER = "var(--mantine-color-default-border)";
const CHROME =
  "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))";

export interface ShellTab {
  id: string;
  /** What the tab says, and what closing it is called. */
  label: string;
  /** The hover text. */
  title: string;
  icon: ReactNode;
  /** Shown in italics; the next single click on an item replaces it. */
  transient: boolean;
  /** Has unsaved changes: a dot takes the place of the close button. */
  dirty: boolean;
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
}: {
  width: number;
  onWidthChange: (width: number) => void;
  sidebar: ReactNode;
  tabs: readonly ShellTab[];
  active: string | null;
  onActivate: (id: string) => void;
  /** A double click on a tab: keep it open. */
  onKeep: (id: string) => void;
  onRequestClose: (id: string) => void;
  /** The active tab's content; null shows `empty`. */
  content: ReactNode;
  empty: string;
  statusLeft: string;
  statusRight: ReactNode;
  tabListLabel: string;
  resizeLabel: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const resizeTo = (clientX: number) => {
    const left = container.current?.getBoundingClientRect().left ?? 0;
    onWidthChange(clampWidth(clientX - left));
  };

  return (
    <Box
      ref={container}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        border: `1px solid ${BORDER}`,
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--mantine-color-body)",
      }}
    >
      <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <Box
          style={{
            width,
            flexShrink: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: CHROME,
          }}
        >
          {sidebar}
        </Box>

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
            if (e.key === "ArrowLeft") onWidthChange(clampWidth(width - 16));
            if (e.key === "ArrowRight") onWidthChange(clampWidth(width + 16));
          }}
        />

        <Box
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box
            role="tablist"
            aria-label={tabListLabel}
            style={{
              display: "flex",
              overflowX: "auto",
              flexShrink: 0,
              minHeight: 34,
              borderBottom: `1px solid ${BORDER}`,
              background: CHROME,
            }}
          >
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
                  onKeyDown={(e) => {
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
                    borderTop: `2px solid ${isActive ? "var(--mantine-primary-color-filled)" : "transparent"}`,
                    background: isActive
                      ? "var(--mantine-color-body)"
                      : undefined,
                    color: isActive ? undefined : "var(--mantine-color-dimmed)",
                  }}
                >
                  {t.icon}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.label}
                  </span>
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
          </Box>

          <Box style={{ flex: 1, minHeight: 0 }}>
            {content ?? (
              <Box
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text size="sm" c="dimmed">
                  {empty}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      <Box
        role="status"
        px="sm"
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexShrink: 0,
          minHeight: 24,
          alignItems: "center",
          borderTop: `1px solid ${BORDER}`,
          background: CHROME,
        }}
      >
        <Text size="xs" c="dimmed" truncate>
          {statusLeft}
        </Text>
        <Box style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          {statusRight}
        </Box>
      </Box>
    </Box>
  );
}
