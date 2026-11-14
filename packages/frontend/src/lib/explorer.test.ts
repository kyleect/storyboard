import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewIn, rootLabel, saveViewIn } from "./explorer";

describe("roots that are not files'", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names a file root by its label and any other root by its id", () => {
    expect(rootLabel("global")).toBe("Global");
    expect(rootLabel("agent:editor")).toBe("agent:editor");
  });

  it("remembers a view under a page key that is a string", () => {
    const view = {
      tabs: [
        {
          kind: "file" as const,
          root: "agent",
          key: "a/SKILL.md",
          transient: false,
        },
      ],
      active: "file|agent|a/SKILL.md",
      expanded: { "agent|root|": true },
      width: 300,
      showDeleted: true,
    };
    saveViewIn("skills", "global", view);
    const isRoot = (v: unknown) => v === "agent";
    expect(loadViewIn("skills", "global", ["file"], isRoot)).toEqual(view);
    expect(localStorage.getItem("harness.skills.global")).not.toBeNull();
  });

  it("drops saved tabs of a root the page no longer has", () => {
    saveViewIn("skills", "global", {
      tabs: [
        { kind: "file", root: "agent", key: "a", transient: false },
        { kind: "file", root: "gone", key: "b", transient: false },
      ],
      active: "file|gone|b",
      expanded: {},
      width: 280,
      showDeleted: false,
    });
    const loaded = loadViewIn(
      "skills",
      "global",
      ["file"],
      (v) => v === "agent",
    );
    expect(loaded.tabs.map((t) => t.root)).toEqual(["agent"]);
    expect(loaded.active).toBeNull();
  });

  it("keeps refusing roots that are not the three file roots by default", () => {
    saveViewIn(
      "files",
      { scope: "global" },
      {
        tabs: [{ kind: "file", root: "agent", key: "a", transient: false }],
        active: null,
        expanded: {},
        width: 280,
        showDeleted: false,
      },
    );
    expect(loadViewIn("files", { scope: "global" }, ["file"]).tabs).toEqual([]);
  });
});
