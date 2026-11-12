import { DEFAULT_THEME } from "@mantine/core";
import { create } from "zustand";

/*
 * How the app looks, kept for this browser (Settings, General, Look & Feel):
 * the theme's primary colour. Like the Sessions page's preferences it lives in
 * localStorage, since it is about this screen, not about the data. The colour
 * is one of Mantine's own palettes, because the theme's `primaryColor` has to
 * name a palette of ten shades.
 */

/** The palettes to choose from: Mantine's, less `dark`, which is for surfaces. */
export const PRIMARY_COLORS: readonly string[] = Object.keys(
  DEFAULT_THEME.colors,
).filter((name) => name !== "dark");

export const DEFAULT_PRIMARY = DEFAULT_THEME.primaryColor;

/** A palette's swatch: its colour at the default primary shade. */
export function swatchOf(name: string): string {
  const palette = DEFAULT_THEME.colors[name];
  const shade = DEFAULT_THEME.primaryShade;
  const at = typeof shade === "number" ? shade : shade.light;
  return (palette?.[at] ?? DEFAULT_THEME.colors.blue?.[at] ?? "").toLowerCase();
}

/** The palette a swatch belongs to; null for any other colour. */
export function paletteOf(swatch: string): string | null {
  const wanted = swatch.toLowerCase();
  return PRIMARY_COLORS.find((name) => swatchOf(name) === wanted) ?? null;
}

const KEY = "harness.appearance";

function load(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_PRIMARY;
    const saved = JSON.parse(raw) as { primaryColor?: unknown } | null;
    const name = saved?.primaryColor;
    return typeof name === "string" && PRIMARY_COLORS.includes(name)
      ? name
      : DEFAULT_PRIMARY;
  } catch {
    return DEFAULT_PRIMARY;
  }
}

function save(primaryColor: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ primaryColor }));
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
}

interface AppearanceState {
  primaryColor: string;
  setPrimaryColor: (name: string) => void;
}

export const useAppearance = create<AppearanceState>((set) => ({
  primaryColor: load(),
  setPrimaryColor: (name) => {
    if (!PRIMARY_COLORS.includes(name)) return;
    save(name);
    set({ primaryColor: name });
  },
}));
