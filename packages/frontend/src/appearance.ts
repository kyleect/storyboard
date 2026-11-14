import { DEFAULT_THEME } from "@mantine/core";
import { create } from "zustand";
import { profileSuffix } from "./profile";

/*
 * How the app looks, kept for this browser (Settings, General, Look & Feel):
 * the theme's primary colour. Like the Sessions page's preferences it lives in
 * localStorage, since it is about this screen, not about the data. It is kept
 * per profile, so each profile can look its own way: the Default profile keeps
 * the key that existed before profiles, and the others add `.p.<id>` (see
 * `profile.ts`). `reload` reads it again after the profile changes. The colour
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

const key = (): string => `harness.appearance${profileSuffix()}`;

function load(): string {
  try {
    const raw = localStorage.getItem(key());
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
    localStorage.setItem(key(), JSON.stringify({ primaryColor }));
  } catch {
    // storage unavailable; the choice lasts until the page reloads
  }
}

interface AppearanceState {
  primaryColor: string;
  setPrimaryColor: (name: string) => void;
  /** Read the colour again, for the profile that is now current. */
  reload: () => void;
}

export const useAppearance = create<AppearanceState>((set) => ({
  primaryColor: load(),
  setPrimaryColor: (name) => {
    if (!PRIMARY_COLORS.includes(name)) return;
    save(name);
    set({ primaryColor: name });
  },
  reload: () => set({ primaryColor: load() }),
}));
