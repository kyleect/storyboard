import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { Link } from "@tanstack/react-router";
import type { ContinuedFrom, ContinuedTo } from "../../../api";
import { messageAnchor } from "../../../components/ErrorList";

export function ContinuedFromLine({ from }: { from: ContinuedFrom }) {
  if (from.state === "gone") {
    return (
      <Text size="xs" c="dimmed">
        Continued from {from.title} (deleted)
      </Text>
    );
  }

  return (
    <Text size="xs" c="dimmed">
      Continued from{" "}
      <Anchor
        size="xs"
        renderRoot={(props) => (
          <Link
            {...props}
            to="/sessions/$sessionId"
            params={{ sessionId: from.id }}
          />
        )}
      >
        {from.title}
      </Anchor>
      {from.state === "trashed" ? " (in the Trash)" : ""}
    </Text>
  );
}

export function CarriedDivider({ from }: { from: ContinuedFrom | null }) {
  const label = from
    ? `Continued from “${from.title}”. ${from.carried} ${
        from.carried === 1 ? "message" : "messages"
      } carried over`
    : "Continued from an earlier session";

  return (
    <Divider
      my="xs"
      labelPosition="center"
      label={
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      }
    />
  );
}

export function ContinuedToBanner({ to }: { to: ContinuedTo }) {
  return (
    <Alert color="blue" title="This session was continued in a new one">
      <Group justify="space-between">
        <Text size="sm">
          It is read only. Carry on in “{to.title}”
          {to.trashed ? " (in the Trash)" : ""}.
        </Text>
        <Button
          size="xs"
          variant="light"
          renderRoot={(props) => (
            <Link
              {...props}
              to="/sessions/$sessionId"
              params={{ sessionId: to.id }}
            />
          )}
        >
          Open
        </Button>
      </Group>
    </Alert>
  );
}

export interface SessionHit {
  session: string;
  sessionId: string;
  messageId: string;
  excerpt: string;
}

/** The hits of a `sessions_search` result, or undefined if it has another shape. */
export function sessionHitsOf(data: unknown): SessionHit[] | undefined {
  const hits = (data as { hits?: unknown } | null | undefined)?.hits;

  if (!Array.isArray(hits)) return undefined;

  const valid = hits.every(
    (h) =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as SessionHit).sessionId === "string" &&
      typeof (h as SessionHit).messageId === "string" &&
      typeof (h as SessionHit).session === "string" &&
      typeof (h as SessionHit).excerpt === "string",
  );

  return valid ? (hits as SessionHit[]) : undefined;
}

export function SessionHits({ hits }: { hits: SessionHit[] }) {
  if (hits.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Nothing found in the earlier sessions.
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      {hits.map((hit) => (
        <div key={hit.messageId}>
          <Anchor
            size="xs"
            renderRoot={(props) => (
              <Link
                {...props}
                to="/sessions/$sessionId"
                params={{ sessionId: hit.sessionId }}
                hash={messageAnchor(hit.messageId)}
              />
            )}
          >
            {hit.session}
          </Anchor>
          <Text size="sm">{hit.excerpt}</Text>
        </div>
      ))}
    </Stack>
  );
}
