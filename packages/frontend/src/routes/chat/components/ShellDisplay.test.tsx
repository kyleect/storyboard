import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useToolOutput } from "../../../stores/tool-output";
import {
  ShellCommand,
  ShellLiveOutput,
  ShellOutcomeView,
} from "./ShellDisplay";

const wrap = (node: React.ReactNode) =>
  render(<MantineProvider>{node}</MantineProvider>);

afterEach(() => useToolOutput.setState({ byCall: {} }));

describe("ShellCommand", () => {
  it("shows the command with its real line breaks, the folder and the model's note", () => {
    wrap(
      <ShellCommand
        call={{
          command: "echo a\necho b",
          cwd: "/home/kim/book/src",
          timeoutSeconds: undefined,
          description: "Print two lines",
        }}
        where="Book"
      />,
    );
    expect(screen.getByTestId("shell-command").textContent).toBe(
      "echo a\necho b",
    );
    expect(
      screen.getByText("Runs in /home/kim/book/src (workspace Book)"),
    ).toBeTruthy();
    expect(screen.getByText("The model says: Print two lines")).toBeTruthy();
  });

  it("says so when the call gave no folder", () => {
    wrap(
      <ShellCommand
        call={{
          command: "ls",
          cwd: "",
          timeoutSeconds: undefined,
          description: undefined,
        }}
      />,
    );
    expect(screen.getByText("Runs in no folder given")).toBeTruthy();
    expect(screen.queryByText(/The model says/)).toBeNull();
  });
});

describe("ShellLiveOutput", () => {
  it("shows nothing until output arrives, then what has arrived", () => {
    wrap(<ShellLiveOutput callId="c1" />);
    expect(screen.queryByTestId("shell-live")).toBeNull();
    act(() => {
      useToolOutput.getState().append("c1", "one\n");
      useToolOutput.getState().append("c1", "two\n");
    });
    expect(screen.getByTestId("shell-live").textContent).toBe("one\ntwo\n");
    act(() => useToolOutput.getState().clear("c1"));
    expect(screen.queryByTestId("shell-live")).toBeNull();
  });
});

describe("ShellOutcomeView", () => {
  const base = {
    signal: null,
    timedOut: false,
    durationMs: 100,
    workspace: "Book",
    folder: "",
    timeoutSeconds: 120,
    notice: undefined,
  };

  it("shows the exit code and the output", () => {
    wrap(
      <ShellOutcomeView
        outcome={{ ...base, exitCode: 1, output: "failed\n" }}
      />,
    );
    expect(screen.getByText("Exit code 1 after 100 ms")).toBeTruthy();
    expect(screen.getByTestId("shell-output").textContent).toBe("failed\n");
  });

  it("says when there was no output, and shows a notice", () => {
    wrap(
      <ShellOutcomeView
        outcome={{
          ...base,
          exitCode: 0,
          output: "",
          notice: "Lowered to 600.",
        }}
      />,
    );
    expect(screen.getByText("No output.")).toBeTruthy();
    expect(screen.getByText("Lowered to 600.")).toBeTruthy();
  });
});
