import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type Project } from "../api";
import { ProjectPage } from "./ProjectPage";

/*
 * A project's page has its chats (the table of the Sessions page, so the
 * tree needs no "All chats" row) and links to its other pages.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children?: React.ReactNode;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
  useParams: () => ({}),
}));
vi.mock("./Sessions", () => ({
  SessionsPage: ({ projectId }: { projectId: string | null }) => (
    <div>sessions table {projectId}</div>
  ),
}));
vi.mock("./Agents", () => ({ DefaultAgentSelect: () => null }));
vi.mock("./Workspaces", () => ({ AttachedWorkspaces: () => null }));

const project = {
  id: "p1",
  name: "Novel",
  description: "",
  created_at: "2026-01-01",
  last_used_at: "2026-01-01",
  trashed_at: null,
  default_agent_id: null,
  system_prompt: "",
  color: null,
} as Project;

afterEach(() => vi.restoreAllMocks());

function show(shown: Project = project) {
  vi.spyOn(api, "getProject").mockResolvedValue(shown);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ProjectPage projectId="p1" />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

describe("a project's page", () => {
  it("shows the project's chats", async () => {
    show();
    expect(await screen.findByText("sessions table p1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });

  it("links to files, agents, skills and Structured Data", async () => {
    show();
    await screen.findByText("sessions table p1");
    const href = (name: string) =>
      screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Files")).toBe("/projects/$projectId/files");
    expect(href("Agents")).toBe("/projects/$projectId/agents");
    expect(href("Skills")).toBe("/projects/$projectId/skills");
    expect(href("Structured Data")).toBe("/projects/$projectId/data");
  });
});

describe("a project's color", () => {
  const checked = () =>
    screen
      .getAllByRole("radio")
      .filter((r) => r.getAttribute("aria-checked") === "true")
      .map((r) => r.getAttribute("aria-label"));

  it("shows the project's color", async () => {
    show({ ...project, color: "teal" });
    await screen.findByText("sessions table p1");
    expect(checked()).toEqual(["Teal"]);
  });

  it("shows no color for a project that has none", async () => {
    show();
    await screen.findByText("sessions table p1");
    expect(checked()).toEqual(["No color"]);
  });

  it("saves the color that is picked, and none when that is picked", async () => {
    const update = vi
      .spyOn(api, "updateProject")
      .mockResolvedValue({ ...project, color: "orange" });
    show({ ...project, color: "teal" });
    await screen.findByText("sessions table p1");

    fireEvent.click(screen.getByRole("radio", { name: "Orange" }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith("p1", { color: "orange" }),
    );
    await waitFor(() => expect(checked()).toEqual(["Orange"]));

    update.mockResolvedValue({ ...project, color: null });
    fireEvent.click(screen.getByRole("radio", { name: "No color" }));
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith("p1", { color: null }),
    );
  });

  it("cannot be changed for a project in the trash", async () => {
    const update = vi.spyOn(api, "updateProject");
    show({ ...project, color: "teal", trashed_at: "2026-02-01" });
    await screen.findByText("sessions table p1");
    fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    expect(update).not.toHaveBeenCalled();
    expect(checked()).toEqual(["Teal"]);
  });
});
