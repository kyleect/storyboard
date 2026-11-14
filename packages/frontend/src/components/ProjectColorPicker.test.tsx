import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PROJECT_COLORS, type ProjectColor } from "@harness/core";
import { ProjectColorPicker } from "./ProjectColorPicker";

function show(
  value: ProjectColor | null,
  onChange: (c: ProjectColor | null) => void = () => {},
  disabled = false,
) {
  render(
    <MantineProvider>
      <ProjectColorPicker
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </MantineProvider>,
  );
}

const checked = () =>
  screen
    .getAllByRole("radio")
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map((r) => r.getAttribute("aria-label"));

describe("the project color picker", () => {
  it("offers no color and every color of the palette", () => {
    show(null);
    expect(screen.getAllByRole("radio")).toHaveLength(
      PROJECT_COLORS.length + 1,
    );
    expect(screen.getByRole("radio", { name: "No color" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Teal" })).toBeTruthy();
  });

  it("marks the current choice", () => {
    show(null);
    expect(checked()).toEqual(["No color"]);
  });

  it("marks a color", () => {
    show("grape");
    expect(checked()).toEqual(["Grape"]);
  });

  it("reports the color that is clicked, and none when that is clicked", () => {
    const onChange = vi.fn();

    show("blue", onChange);
    fireEvent.click(screen.getByRole("radio", { name: "Orange" }));
    expect(onChange).toHaveBeenLastCalledWith("orange");
    fireEvent.click(screen.getByRole("radio", { name: "No color" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("does not report the choice that is already made", () => {
    const onChange = vi.fn();

    show("blue", onChange);
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cannot be changed while disabled", () => {
    const onChange = vi.fn();

    show("blue", onChange, true);
    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
