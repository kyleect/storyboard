import { ColorInput, Stack, Text } from "@mantine/core";
import {
  paletteOf,
  PRIMARY_COLORS,
  swatchOf,
  useAppearance,
} from "../../../stores/appearance";

const SWATCHES = PRIMARY_COLORS.map(swatchOf);

export function LookAndFeel() {
  const primaryColor = useAppearance((s) => s.primaryColor);
  const setPrimaryColor = useAppearance((s) => s.setPrimaryColor);

  return (
    <Stack maw={480}>
      <ColorInput
        label="Theme color"
        description={`The ${primaryColor} palette. Used for the selected tab, links and buttons, and for the browser tab's icon.`}
        value={swatchOf(primaryColor)}
        swatches={SWATCHES}
        swatchesPerRow={7}
        withPicker={false}
        withEyeDropper={false}
        disallowInput
        format="hex"
        onChange={(color) => {
          const name = paletteOf(color);
          if (name) setPrimaryColor(name);
        }}
      />
      <Text size="xs" c="dimmed">
        Kept in this browser, not on the server, and applied at once.
      </Text>
    </Stack>
  );
}
