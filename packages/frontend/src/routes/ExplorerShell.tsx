import { Box, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useRef, useState, type ReactNode } from "react";
import { clampWidth } from "../explorer";
import { UnreadDot } from "./UnreadDot";

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
  /** Where the tab belongs, shown before the label: a project's name. */
  prefix?: string;
  /** The hover text. */
  title: string;
  icon: ReactNode;
  /** Shown in italics; the next single click on an item replaces it. */
  transient: boolean;
  /** Has unsaved changes: a dot takes the place of the close button. */
  dirty: boolean;
  /** Has a reply the user has not seen: a dot after the label. */
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
  /** Before the first tab, such as the button that opens a drawer. */
  leading?: ReactNode;
  /** On a small screen the sidebar is elsewhere: no sidebar, no divider. */
  /**
   * Tabs can be dragged, or moved with Alt and the arrow keys; called with
   * the tab and the index it should take. Without it they stay put.
   */
  onReorder?: (id: string, toIndex: number) => void;
  hideSidebar?: boolean;
  hideStatus?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The tab being dragged, and the one it is over.
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
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
        {!hideSidebar && (
          <>
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
                if (e.key === "ArrowLeft")
                  onWidthChange(clampWidth(width - 16));
                if (e.key === "ArrowRight")
                  onWidthChange(clampWidth(width + 16));
              }}
            />
          </>
        )}

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
                    borderTop: `2px solid ${isActive ? "var(--mantine-primary-color-filled)" : "transparent"}`,
                    background: isActive
                      ? "var(--mantine-color-body)"
                      : undefined,
                    color: isActive ? undefined : "var(--mantine-color-dimmed)",
                  }}
                >
                  {t.icon}
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

      {!hideStatus && (
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
      )}
    </Box>
  );
}
