import { Box, Center, type RenderTreeNodePayload } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import classes from "./tree.module.css";

export const INHERITED = "var(--mantine-color-blue-6)";

type RowProps = Omit<ComponentPropsWithoutRef<"div">, "style" | "className"> & {
  elementProps: RenderTreeNodePayload["elementProps"];
  deleted?: boolean;
  waiting?: boolean;
};

export function TreeRow({
  elementProps,
  deleted = false,
  waiting = false,
  ...rest
}: RowProps) {
  return (
    <Box
      {...elementProps}
      {...rest}
      className={`${elementProps.className} ${classes.row}`}
      data-deleted={deleted || undefined}
      data-waiting={waiting || undefined}
    />
  );
}

export function TreeChevron({
  show,
  expanded,
}: {
  show: boolean;
  expanded: boolean;
}) {
  return (
    <Center inline w={14} c="dimmed" flex="none">
      {show &&
        (expanded ? (
          <IconChevronDown size={14} />
        ) : (
          <IconChevronRight size={14} />
        ))}
    </Center>
  );
}

export function TreeIcon({
  inherited = false,
  children,
}: {
  inherited?: boolean;
  children: ReactNode;
}) {
  return (
    <Center inline flex="none" {...(inherited ? { c: INHERITED } : {})}>
      {children}
    </Center>
  );
}

export function TreeMenuAnchor({
  menu,
  ref,
}: {
  menu: { x: number; y: number } | null;
  ref?: Ref<HTMLSpanElement>;
}) {
  return (
    <Box
      ref={ref}
      component="span"
      pos="fixed"
      w={0}
      h={0}
      style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
    />
  );
}
