import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewIn, saveViewIn } from "../lib/explorer";
import {
  DEFAULT_PROFILE,
  currentProfile,
  profileSuffix,
  setCurrentProfile,
} from "./profile";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => {
  setCurrentProfile(DEFAULT_PROFILE);
  vi.unstubAllGlobals();
});

describe("profile", () => {
  it("starts on Default, whose saved-view keys are the pre-profile ones", () => {
    expect(currentProfile()).toBe("default");
    expect(profileSuffix()).toBe("");
  });

  it("suffixes other profiles' saved-view keys with their id", () => {
    setCurrentProfile("work");
    expect(currentProfile()).toBe("work");
    expect(profileSuffix()).toBe(".p.work");
  });

  it("keeps each profile's open tabs apart, so switching back finds them", () => {
    const view = (key: string) => ({
      tabs: [{ kind: "file", root: "global", key, transient: false }],
      active: `file:global:${key}`,
      expanded: {},
      width: 260,
      showDeleted: false,
    });
    const kinds = ["file"] as const;
    const isRoot = (v: unknown) => v === "global";

    saveViewIn("test", "page", view("a.md") as never);
    setCurrentProfile("work");
    expect(loadViewIn("test", "page", kinds, isRoot).tabs).toEqual([]);
    saveViewIn("test", "page", view("b.md") as never);

    setCurrentProfile("default");
    expect(loadViewIn("test", "page", kinds, isRoot).tabs[0]?.key).toBe("a.md");
    setCurrentProfile("work");
    expect(loadViewIn("test", "page", kinds, isRoot).tabs[0]?.key).toBe("b.md");
    expect(localStorage.getItem("harness.test.page")).not.toBeNull();
    expect(localStorage.getItem("harness.test.page.p.work")).not.toBeNull();
  });
});
