import type { ProjectColor } from "@harness/core";

export function projectColorVar(
  color: ProjectColor | null | undefined,
): string | undefined {
  return color ? `var(--mantine-color-${color}-6)` : undefined;
}
