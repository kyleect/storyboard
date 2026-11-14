import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExplorerShell, type ShellTab } from "./ExplorerShell";

const tab = (id: string, over: Partial<ShellTab> = {}): ShellTab => ({
  id,
  label: `Chat ${id}`,
  title: `Chat: ${id}`,
  icon: null,
  transient: false,
  dirty: false,
  ...over,
});

function renderShell(tabs: ShellTab[]) {
  render(
    <MantineProvider>
      <ExplorerShell
        width={240}
        onWidthChange={() => {}}
        sidebar={null}
        tabs={tabs}
        active="a"
        onActivate={() => {}}
        onKeep={() => {}}
        onRequestClose={() => {}}
        content={null}
        empty="Nothing open"
        statusLeft=""
        statusRight={null}
        tabListLabel="Open chats"
        resizeLabel="Resize"
      />
    </MantineProvider>,
  );
}

const dotIn = (name: string) =>
  within(screen.getByRole("tab", { name: new RegExp(name) })).queryByRole(
    "img",
    { name: "New reply" },
  );

describe("ExplorerShell tabs", () => {
  it("marks a tab that has a reply the user has not seen", () => {
    renderShell([tab("a"), tab("b", { unread: true })]);
    expect(dotIn("Chat b")).not.toBeNull();
  });

  it("leaves the other tabs unmarked", () => {
    renderShell([tab("a"), tab("b", { unread: true })]);
    expect(dotIn("Chat a")).toBeNull();
  });
});

describe("ExplorerShell tabs of a project", () => {
  const lineOf = (name: string) =>
    screen.getByRole("tab", { name: new RegExp(name) }).style.borderTop;

  it("shows the project's color over the open tab and behind its icon", () => {
    renderShell([tab("a", { iconColor: "teal", icon: <span>i</span> })]);
    expect(lineOf("Chat a")).toContain("--mantine-color-teal-filled");
    const icon = screen
      .getByRole("tab", { name: /Chat a/ })
      .querySelector(".mantine-ThemeIcon-root") as HTMLElement;
    expect(icon.style.getPropertyValue("--ti-bg")).toContain(
      "--mantine-color-teal-filled",
    );
  });

  it("keeps the theme's color for a tab without one", () => {
    renderShell([tab("a")]);
    expect(lineOf("Chat a")).toContain("--mantine-primary-color-filled");
  });

  it("shows the line only on the open tab", () => {
    renderShell([tab("a"), tab("b", { iconColor: "teal" })]);
    expect(lineOf("Chat b")).toContain("transparent");
  });
});
