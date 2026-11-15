import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CarriedDivider,
  ContinuedFromLine,
  ContinuedToBanner,
  SessionHits,
  sessionHitsOf,
} from "./Continuation";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    hash,
    children,
    ...rest
  }: {
    to: string;
    params: Record<string, string>;
    hash?: string;
    children?: React.ReactNode;
  }) => (
    <a
      href={`${to.replace("$sessionId", params.sessionId ?? "")}${hash ? `#${hash}` : ""}`}
      {...rest}
    >
      {children}
    </a>
  ),
}));

const wrap = (node: React.ReactNode) =>
  render(<MantineProvider>{node}</MantineProvider>);

const from = (state: "live" | "trashed" | "gone", carried = 3) => ({
  id: "s1",
  title: "Plot",
  state,
  carried,
});

describe("ContinuedFromLine", () => {
  it("links to the session it continues", () => {
    wrap(<ContinuedFromLine from={from("live")} />);
    expect(
      screen.getByRole("link", { name: "Plot" }).getAttribute("href"),
    ).toBe("/sessions/s1");
  });

  it("says when it is in the trash, and when it is gone", () => {
    const { unmount } = wrap(<ContinuedFromLine from={from("trashed")} />);

    expect(screen.getByText(/\(in the Trash\)/)).toBeTruthy();
    unmount();
    wrap(<ContinuedFromLine from={from("gone")} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Plot \(deleted\)/)).toBeTruthy();
  });
});

describe("CarriedDivider", () => {
  it("names the session and counts the messages carried over", () => {
    wrap(<CarriedDivider from={from("live", 4)} />);
    expect(
      screen.getByText("Continued from “Plot”. 4 messages carried over"),
    ).toBeTruthy();
  });

  it("uses the singular for one message, and a plain line without the link", () => {
    const { unmount } = wrap(<CarriedDivider from={from("live", 1)} />);

    expect(screen.getByText(/1 message carried over/)).toBeTruthy();
    unmount();
    wrap(<CarriedDivider from={null} />);
    expect(screen.getByText("Continued from an earlier session")).toBeTruthy();
  });
});

describe("ContinuedToBanner", () => {
  it("says the session is read only and links to the new one", () => {
    wrap(
      <ContinuedToBanner
        to={{ id: "s2", title: "Plot (2)", trashed: false }}
      />,
    );
    expect(
      screen.getByText("This session was continued in a new one"),
    ).toBeTruthy();
    expect(screen.getByText(/It is read only/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/sessions/s2");
  });

  it("notes a new session that is in the trash", () => {
    wrap(
      <ContinuedToBanner to={{ id: "s2", title: "Plot (2)", trashed: true }} />,
    );
    expect(screen.getByText(/\(in the Trash\)/)).toBeTruthy();
  });
});

describe("sessions_search hits", () => {
  const hit = {
    session: "Plot",
    sessionId: "s1",
    messageId: "m7",
    excerpt: "We chose the lighthouse",
    matched: "keyword",
  };

  it("links each hit to its message in the earlier session", () => {
    const hits = sessionHitsOf({ hits: [hit], hasMore: false });

    expect(hits).toHaveLength(1);
    wrap(<SessionHits hits={hits ?? []} />);
    expect(screen.getByText("We chose the lighthouse")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Plot" }).getAttribute("href"),
    ).toBe("/sessions/s1#message-m7");
  });

  it("says when nothing was found", () => {
    wrap(<SessionHits hits={[]} />);
    expect(
      screen.getByText("Nothing found in the earlier sessions."),
    ).toBeTruthy();
  });

  it("does not take another shape for hits", () => {
    expect(sessionHitsOf(undefined)).toBeUndefined();
    expect(sessionHitsOf({ hits: "no" })).toBeUndefined();
    expect(sessionHitsOf({ hits: [{ session: 1 }] })).toBeUndefined();
    expect(sessionHitsOf({ messages: [] })).toBeUndefined();
  });
});
