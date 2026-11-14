import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swatchOf, useAppearance } from "../../../stores/appearance";
import { LookAndFeel } from "./LookAndFeel";

beforeEach(() => {
  localStorage.clear();
  useAppearance.setState({ primaryColor: "blue" });
});

afterEach(() => {
  localStorage.clear();
});

const show = () =>
  render(
    <MantineProvider>
      <LookAndFeel />
    </MantineProvider>,
  );

describe("Look & Feel", () => {
  it("shows the current theme colour", () => {
    show();
    const input = screen.getByLabelText("Theme color") as HTMLInputElement;
    expect(input.value).toBe(swatchOf("blue"));
    expect(screen.getByText(/The blue palette/)).toBeTruthy();
  });

  it("changes the theme colour when a swatch is picked, and keeps it", async () => {
    show();
    fireEvent.focus(screen.getByLabelText("Theme color"));
    fireEvent.click(await screen.findByLabelText(swatchOf("grape")));
    await waitFor(() =>
      expect(useAppearance.getState().primaryColor).toBe("grape"),
    );
    expect(localStorage.getItem("harness.appearance")).toContain("grape");
    expect(screen.getByText(/The grape palette/)).toBeTruthy();
  });

  it("does not let a typed colour through", () => {
    show();
    const input = screen.getByLabelText("Theme color") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
  });
});
