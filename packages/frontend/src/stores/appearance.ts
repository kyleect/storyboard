import { DEFAULT_THEME } from "@mantine/core";
import { create } from "zustand";
import { profileSuffix } from "./profile";

export const PRIMARY_COLORS: readonly string[] = Object.keys(
  DEFAULT_THEME.colors,
).filter((name) => name !== "dark");

export const DEFAULT_PRIMARY = DEFAULT_THEME.primaryColor;

export function swatchOf(name: string): string {
  const palette = DEFAULT_THEME.colors[name];
  const shade = DEFAULT_THEME.primaryShade;
  const at = typeof shade === "number" ? shade : shade.light;
  return (palette?.[at] ?? DEFAULT_THEME.colors.blue?.[at] ?? "").toLowerCase();
}

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
    // storage can be unavailable
  }
}

interface AppearanceState {
  primaryColor: string;
  setPrimaryColor: (name: string) => void;
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
