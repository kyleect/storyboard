import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { SessionRunBadge } from "./RunIndicator";

function renderBadge(props: ComponentProps<typeof SessionRunBadge>) {
  render(
    <MantineProvider>
      <SessionRunBadge {...props} />
    </MantineProvider>,
  );
}

const dot = () => screen.queryByRole("img", { name: "New reply" });

describe("SessionRunBadge", () => {
  it("shows a dot for a reply not yet seen", () => {
    renderBadge({ state: undefined, unread: true });
    expect(dot()).not.toBeNull();
  });

  it("shows nothing when there is nothing new", () => {
    renderBadge({ state: undefined, unread: false });
    expect(dot()).toBeNull();
  });

  it("shows the waiting badge, not the dot, when a run waits for the user", () => {
    renderBadge({ state: "waiting", unread: true });
    expect(
      screen.queryByRole("img", { name: "Waiting for you" }),
    ).not.toBeNull();
    expect(dot()).toBeNull();
  });

  it("does not flash the dot while a run's spinner is still pending", () => {
    renderBadge({ state: "running", unread: true });
    expect(dot()).toBeNull();
  });
});
