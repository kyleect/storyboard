import {
  Anchor,
  Blockquote,
  Checkbox,
  Code,
  Divider,
  List,
  Stack,
  Table,
  Text,
  Title,
  type MantineFontSize,
} from "@mantine/core";
import utils from "../styles/utilities.module.css";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const n = node as { value?: unknown; children?: unknown };
  if (typeof n.value === "string") return n.value;
  return Array.isArray(n.children) ? n.children.map(textOf).join("") : "";
}

const LINKABLE = /^(https?:|mailto:)/i;

const heading =
  (order: 1 | 2 | 3 | 4 | 5 | 6, size: string): NonNullable<Components["h1"]> =>
  ({ children }) => (
    <Title order={order} size={size}>
      {children}
    </Title>
  );

const components: Components = {
  h1: heading(1, "h3"),
  h2: heading(2, "h4"),
  h3: heading(3, "h5"),
  h4: heading(4, "h6"),
  h5: heading(5, "sm"),
  h6: heading(6, "sm"),
  p: ({ children }) => (
    <Text inherit className={utils.preWrap}>
      {children}
    </Text>
  ),
  strong: ({ children }) => (
    <Text span inherit fw={700}>
      {children}
    </Text>
  ),
  em: ({ children }) => (
    <Text span inherit fs="italic">
      {children}
    </Text>
  ),
  del: ({ children }) => (
    <Text span inherit td="line-through">
      {children}
    </Text>
  ),
  a: ({ href, children }) =>
    href && LINKABLE.test(href) ? (
      <Anchor inherit href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </Anchor>
    ) : (
      <Text span inherit>
        {children}
      </Text>
    ),
  img: ({ alt }) => (
    <Text span inherit>
      {alt}
    </Text>
  ),
  ul: ({ children, className }) => (
    <List
      withPadding
      {...(className?.includes("contains-task-list")
        ? { listStyleType: "none" }
        : {})}
    >
      {children}
    </List>
  ),
  ol: ({ children, start }) => (
    <List type="ordered" withPadding {...(start != null ? { start } : {})}>
      {children}
    </List>
  ),
  li: ({ children }) => <List.Item>{children}</List.Item>,
  input: ({ checked }) => (
    <Checkbox
      size="xs"
      checked={checked ?? false}
      readOnly
      aria-label={checked ? "Done" : "Not done"}
      display="inline-flex"
      style={{ verticalAlign: "middle" }}
      mr={6}
    />
  ),
  blockquote: ({ children }) => (
    <Blockquote color="gray" p="xs" mt={0} mb={0}>
      {children}
    </Blockquote>
  ),
  hr: () => <Divider />,
  pre: ({ node }) => <Code block>{textOf(node).replace(/\n$/, "")}</Code>,
  code: ({ children }) => <Code>{children}</Code>,
  table: ({ children }) => (
    <Table.ScrollContainer minWidth={400}>
      <Table withTableBorder withColumnBorders>
        {children}
      </Table>
    </Table.ScrollContainer>
  ),
  thead: ({ children }) => <Table.Thead>{children}</Table.Thead>,
  tbody: ({ children }) => <Table.Tbody>{children}</Table.Tbody>,
  tr: ({ children }) => <Table.Tr>{children}</Table.Tr>,
  th: ({ children, style }) => (
    <Table.Th {...(style ? { style } : {})}>{children}</Table.Th>
  ),
  td: ({ children, style }) => (
    <Table.Td {...(style ? { style } : {})}>{children}</Table.Td>
  ),
};

const remarkPlugins = [remarkGfm];

export const Markdown = memo(function Markdown({
  children,
  size,
}: {
  children: string;
  size?: MantineFontSize;
}) {
  return (
    <Stack gap="xs" {...(size ? { fz: size } : {})}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </Stack>
  );
});
