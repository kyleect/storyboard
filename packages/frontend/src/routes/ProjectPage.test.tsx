import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
} as Project;

afterEach(() => vi.restoreAllMocks());

function show() {
  vi.spyOn(api, "getProject").mockResolvedValue(project);
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
