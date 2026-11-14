import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function renderShell(
  tabs: ShellTab[],
  flush = false,
  handlers: {
    active?: string;
    onActivate?: (id: string) => void;
    onRequestClose?: (id: string) => void;
  } = {},
) {
  return render(
    <MantineProvider>
      <ExplorerShell
        flush={flush}
        width={240}
        onWidthChange={() => {}}
        sidebar={null}
        tabs={tabs}
        active={handlers.active ?? "a"}
        onActivate={handlers.onActivate ?? (() => {})}
        onKeep={() => {}}
        onRequestClose={handlers.onRequestClose ?? (() => {})}
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
  const tabNamed = (name: string) =>
    screen.getByRole("tab", { name: new RegExp(name) });
  const lineColor = (name: string) =>
    tabNamed(name).style.getPropertyValue("--tab-color");

  it("shows the project's color over the open tab and behind its icon", () => {
    renderShell([tab("a", { iconColor: "teal", icon: <span>i</span> })]);
    expect(lineColor("Chat a")).toContain("--mantine-color-teal-filled");
    const icon = screen
      .getByRole("tab", { name: /Chat a/ })
      .querySelector(".mantine-ThemeIcon-root") as HTMLElement;

    expect(icon.style.getPropertyValue("--ti-bg")).toContain(
      "--mantine-color-teal-filled",
    );
  });

  it("keeps the theme's color for a tab without one", () => {
    renderShell([tab("a")]);
    expect(lineColor("Chat a")).toBe("");
  });

  it("shows the line only on the open tab", () => {
    renderShell([tab("a"), tab("b", { iconColor: "teal" })]);
    expect(tabNamed("Chat a").hasAttribute("data-active")).toBe(true);
    expect(tabNamed("Chat b").hasAttribute("data-active")).toBe(false);
  });
});

describe("ExplorerShell frame", () => {
  const frame = (c: HTMLElement) => c.querySelector("div");

  it("draws its own border by default", () => {
    const { container } = renderShell([tab("a")]);

    expect(frame(container)?.getAttribute("style")).toMatch(/border/);
  });

  it("draws no border when it is flush with the page around it", () => {
    const { container } = renderShell([tab("a")], true);

    expect(frame(container)?.getAttribute("style") ?? "").not.toMatch(/border/);
  });
});

describe("ExplorerShell tab menu", () => {
  const tabs = ["a", "b", "c", "d"].map((id) => tab(id));
  const openMenuOn = async (name: string) => {
    fireEvent.contextMenu(screen.getByRole("tab", { name: new RegExp(name) }));
    await screen.findByRole("menuitem", { name: "Close", hidden: true });
  };
  const item = (name: string) =>
    screen.getByRole("menuitem", { name, hidden: true });
  const choose = (name: string) => fireEvent.click(item(name));

  it("offers close, close to the right and close others on right-click", async () => {
    renderShell(tabs);
    await openMenuOn("Chat b");
    expect(item("Close")).toBeTruthy();
    expect(item("Close to the right")).toBeTruthy();
    expect(item("Close others")).toBeTruthy();
  });

  it("closes only the tab that was right-clicked", async () => {
    const onRequestClose = vi.fn();

    renderShell(tabs, false, { onRequestClose });
    await openMenuOn("Chat c");
    choose("Close");
    expect(onRequestClose.mock.calls).toEqual([["c"]]);
  });

  it("closes the tabs to the right of the one that was right-clicked", async () => {
    const onRequestClose = vi.fn();

    renderShell(tabs, false, { onRequestClose });
    await openMenuOn("Chat b");
    choose("Close to the right");
    expect(onRequestClose.mock.calls).toEqual([["c"], ["d"]]);
  });

  it("closes every tab but the one that was right-clicked", async () => {
    const onRequestClose = vi.fn();

    renderShell(tabs, false, { onRequestClose });
    await openMenuOn("Chat b");
    choose("Close others");
    expect(onRequestClose.mock.calls).toEqual([["a"], ["c"], ["d"]]);
  });

  it("opens the right-clicked tab first when the open tab is about to close", async () => {
    const onActivate = vi.fn();
    const onRequestClose = vi.fn();

    renderShell(tabs, false, { active: "a", onActivate, onRequestClose });
    await openMenuOn("Chat c");
    choose("Close others");
    expect(onActivate.mock.calls).toEqual([["c"]]);
  });

  it("leaves the open tab alone when it is not among those closing", async () => {
    const onActivate = vi.fn();

    renderShell(tabs, false, { active: "a", onActivate });
    await openMenuOn("Chat b");
    choose("Close to the right");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("asks about unsaved tabs after closing the saved ones, leftmost question first", async () => {
    const onRequestClose = vi.fn();

    renderShell(
      [
        tab("a"),
        tab("b", { dirty: true }),
        tab("c"),
        tab("d", { dirty: true }),
        tab("e"),
      ],
      false,
      { onRequestClose },
    );
    await openMenuOn("Chat a");
    choose("Close others");
    expect(onRequestClose.mock.calls).toEqual([["c"], ["e"], ["d"], ["b"]]);
  });

  it("cannot close to the right of the last tab", async () => {
    renderShell(tabs);
    await openMenuOn("Chat d");
    expect(item("Close to the right").hasAttribute("data-disabled")).toBe(true);
  });

  it("cannot close others when there is only one tab", async () => {
    renderShell([tab("a")]);
    await openMenuOn("Chat a");
    expect(item("Close others").hasAttribute("data-disabled")).toBe(true);
  });
});
