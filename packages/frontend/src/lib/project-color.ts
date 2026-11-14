import type { ProjectColor } from "@harness/core";

/**
 * The CSS color for a project's color name, drawn from Mantine's theme so it
 * follows the light and dark schemes. Undefined when the project has none, so
 * an icon keeps its normal color.
 */
export function projectColorVar(
  color: ProjectColor | null | undefined,
): string | undefined {
  return color ? `var(--mantine-color-${color}-6)` : undefined;
}
