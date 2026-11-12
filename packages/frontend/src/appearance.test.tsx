import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The theme colour kept for this browser. */

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
});

const load = () => import("./appearance");

describe("appearance", () => {
  it("starts with Mantine's own default colour", async () => {
    const { useAppearance, DEFAULT_PRIMARY } = await load();
    expect(DEFAULT_PRIMARY).toBe("blue");
    expect(useAppearance.getState().primaryColor).toBe("blue");
  });

  it("keeps a chosen colour for the next visit", async () => {
    const first = await load();
    first.useAppearance.getState().setPrimaryColor("grape");
    expect(
      JSON.parse(localStorage.getItem("harness.appearance") ?? "{}"),
    ).toEqual({ primaryColor: "grape" });

    vi.resetModules();
    const second = await load();
    expect(second.useAppearance.getState().primaryColor).toBe("grape");
  });

  it("ignores a name that is not a palette, saved or chosen", async () => {
    localStorage.setItem(
      "harness.appearance",
      JSON.stringify({ primaryColor: "chartreuse" }),
    );
    const { useAppearance } = await load();
    expect(useAppearance.getState().primaryColor).toBe("blue");
    useAppearance.getState().setPrimaryColor("dark");
    expect(useAppearance.getState().primaryColor).toBe("blue");
  });

  it("survives broken stored data", async () => {
    localStorage.setItem("harness.appearance", "{not json");
    const { useAppearance } = await load();
    expect(useAppearance.getState().primaryColor).toBe("blue");
  });

  it("gives each palette its own swatch, and finds the palette from it", async () => {
    const { PRIMARY_COLORS, swatchOf, paletteOf } = await load();
    expect(PRIMARY_COLORS).not.toContain("dark");
    expect(PRIMARY_COLORS).toContain("blue");
    const swatches = PRIMARY_COLORS.map(swatchOf);
    expect(new Set(swatches).size).toBe(PRIMARY_COLORS.length);
    expect(swatchOf("blue")).toBe("#228be6");
    for (const name of PRIMARY_COLORS) {
      expect(paletteOf(swatchOf(name))).toBe(name);
    }
    expect(paletteOf("#228BE6")).toBe("blue");
    expect(paletteOf("#123456")).toBeNull();
  });
});
