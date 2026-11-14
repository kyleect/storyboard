/*
 * The colors a project can be given. They are the names of Mantine's theme
 * colors, so the UI draws them from its own palette (light and dark) instead of
 * storing raw color values. The backend accepts only these names, and the
 * frontend offers them in this order.
 */

export const PROJECT_COLORS = [
  "red",
  "pink",
  "grape",
  "violet",
  "indigo",
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "yellow",
  "orange",
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

export function isProjectColor(value: unknown): value is ProjectColor {
  return (
    typeof value === "string" &&
    (PROJECT_COLORS as readonly string[]).includes(value)
  );
}
