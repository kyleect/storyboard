import { ActionIcon, Badge, createTheme, Paper } from "@mantine/core";

export const theme = createTheme({
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: { variant: "subtle", size: "sm" },
    }),
    Badge: Badge.extend({ defaultProps: { variant: "light", size: "xs" } }),
    Paper: Paper.extend({ defaultProps: { withBorder: true } }),
  },
});
