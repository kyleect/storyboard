import { MantineProvider } from "@mantine/core";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { TreeMenuAnchor } from "./TreeParts";

describe("TreeMenuAnchor", () => {
  it("hands its element to the ref, which Menu.Target needs to place the menu", () => {
    const ref = createRef<HTMLSpanElement>();

    render(
      <MantineProvider>
        <TreeMenuAnchor menu={{ x: 40, y: 60 }} ref={ref} />
      </MantineProvider>,
    );
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
    expect(ref.current?.style.left).toBe("40px");
    expect(ref.current?.style.top).toBe("60px");
  });
});
