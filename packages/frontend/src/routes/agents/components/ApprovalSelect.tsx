import { Select } from "@mantine/core";
import type { ToolApprovalInfo } from "../../../api";

const FOLLOW = "follow";
const ASK = "ask";
const SKIP = "skip";

export function ApprovalSelect({
  tool,
  value,
  disabled,
  onChange,
}: {
  tool: ToolApprovalInfo | undefined;
  value: boolean | undefined;
  disabled: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  const fixed = tool?.fixed ?? false;
  return (
    <Select
      size="xs"
      w={200}
      aria-label={`Approval for ${tool?.name ?? "this tool"}`}
      allowDeselect={false}
      disabled={disabled || fixed || !tool}
      value={
        fixed ? "always" : value === undefined ? FOLLOW : value ? ASK : SKIP
      }
      onChange={(v) =>
        onChange(v === ASK ? true : v === SKIP ? false : undefined)
      }
      data={
        fixed
          ? [{ value: "always", label: "Always asks" }]
          : [
              {
                value: FOLLOW,
                label: `Tool's setting (${tool?.ask ? "asks" : "doesn't ask"})`,
              },
              { value: ASK, label: "Ask" },
              { value: SKIP, label: "Don't ask" },
            ]
      }
    />
  );
}
