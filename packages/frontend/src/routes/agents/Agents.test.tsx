import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentFocus } from "../../stores/agentFocus";
import { AgentBadge } from "./Agents";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  navigate.mockClear();
  useAgentFocus.getState().clear();
});

const show = (projectId: string | null) =>
  render(
    <MantineProvider env="test">
      <AgentBadge agent={{ id: "a1", version: 3, name: "Editor", projectId }} />
    </MantineProvider>,
  );

describe("the agent badge on a message", () => {
  it("shows the agent's name and version", () => {
    show(null);
    expect(screen.getByText("Editor v3")).toBeTruthy();
  });

  it("asks for the agent at that version, on the global Agents page", () => {
    show(null);
    fireEvent.click(screen.getByText("Editor v3"));
    expect(useAgentFocus.getState().request).toEqual({
      agentId: "a1",
      version: 3,
      projectId: null,
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/agents" });
  });

  it("goes to the project's Agents page for a project's agent", () => {
    show("p 1");
    fireEvent.click(screen.getByText("Editor v3"));
    expect(useAgentFocus.getState().request?.projectId).toBe("p 1");
    expect(navigate).toHaveBeenCalledWith({ to: "/projects/p%201/agents" });
  });
});
