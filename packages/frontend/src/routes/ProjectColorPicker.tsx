import { ColorSwatch, Group, Input } from "@mantine/core";
import { IconBan, IconCheck } from "@tabler/icons-react";
import { PROJECT_COLORS, type ProjectColor } from "@harness/core";
import { projectColorVar } from "../project-color";

/**
 * Picks a project's color from the palette, or none. One choice, so the
 * swatches are a radio group; the check marks the current one.
 */
export function ProjectColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ProjectColor | null;
  onChange: (color: ProjectColor | null) => void;
  disabled?: boolean;
}) {
  const swatch = (
    color: ProjectColor | null,
    label: string,
    selected: boolean,
  ) => (
    <ColorSwatch
      key={color ?? "none"}
      component="button"
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      color={projectColorVar(color) ?? "transparent"}
      size={22}
      disabled={disabled}
      onClick={() => {
        if (!selected) onChange(color);
      }}
      style={{
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        // The chosen swatch gets a ring, so it does not rely on the check alone.
        outline: selected ? "2px solid var(--mantine-color-dimmed)" : undefined,
        outlineOffset: 2,
      }}
    >
      {color === null ? (
        <IconBan size={14} color="var(--mantine-color-dimmed)" />
      ) : selected ? (
        <IconCheck size={14} color="white" />
      ) : null}
    </ColorSwatch>
  );

  return (
    // The swatches are not one input, so the heading is not a <label>.
    <Input.Wrapper
      label="Color"
      labelElement="div"
      description="Shown on the project's folder."
    >
      <Group gap={8} mt={6} role="radiogroup" aria-label="Project color">
        {swatch(null, "No color", value === null)}
        {PROJECT_COLORS.map((c) =>
          swatch(c, c.charAt(0).toUpperCase() + c.slice(1), value === c),
        )}
      </Group>
    </Input.Wrapper>
  );
}
