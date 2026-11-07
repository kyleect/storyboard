import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Project, type SessionListItem } from "../api";
import { usePicked } from "../picked";
import { Layout } from "./Layout";

/* The navbar (Sessions page plan, D1 and D2). */

let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: { sessionId?: string };
    children?: ReactNode;
  }) => (
    <a href={to.replace("$sessionId", params?.sessionId ?? "")} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string }) => string;
  }) => select({ pathname }),
  useNavigate: () => () => {},
  useParams: () => ({}),
}));

// The app-wide event stream is not under test.
vi.mock("../live", () => ({ useAppEvents: () => {} }));

const session: SessionListItem = {
  id: "s1",
  title: "Lighthouse",
  created_at: "2026-11-01T10:00:00Z",
  model: null,
  reasoning_effort: null,
  trashed_at: null,
  project_id: null,
  trashed_with_project: 0,
  agent_id: null,
  usage: null,
};

beforeEach(() => {
  pathname = "/";
  usePicked.setState({ projectId: null });
  vi.spyOn(api, "listProjects").mockResolvedValue([]);
  vi.spyOn(api, "listSessions").mockResolvedValue([session]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderLayout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>
          <Layout />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
}

const project: Project = {
  id: "p1",
  name: "Stories",
  description: "",
  created_at: "2026-11-01T10:00:00Z",
  last_used_at: "2026-11-01T10:00:00Z",
  trashed_at: null,
  default_agent_id: null,
  system_prompt: "",
};

/** Pages where the project picker is shown, with the Sessions link above it. */
const PICKER_PAGES = [
  "/sessions",
  "/sessions/s1",
  "/projects/p1",
  "/projects/p1/agents",
  "/projects/p1/files",
  "/projects/p1/skills",
  "/projects/p1/data",
];

/** Pages where it is not: the links are stacked together at the top. */
const NO_PICKER_PAGES = [
  "/",
  "/agents",
  "/skills",
  "/files",
  "/data",
  "/errors",
  "/settings",
];

const picker = () =>
  screen.queryAllByLabelText("Project").find((el) => el.tagName === "INPUT");

const link = (name: string) => screen.getByRole("link", { name });

describe("the navbar: the project picker and the Sessions link", () => {
  it.each(PICKER_PAGES)(
    "shows the picker on %s, with the Sessions link above it",
    (path) => {
      pathname = path;
      renderLayout();
      expect(screen.getAllByRole("link", { name: "Sessions" })).toHaveLength(1);
      expect(link("Sessions").getAttribute("href")).toBe("/sessions");
      expect(picker()).toBeTruthy();
      expect(
        link("Sessions").compareDocumentPosition(picker() as HTMLElement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Not with the links below it.
      expect(link("Sessions").parentElement).not.toBe(
        link("Agents").parentElement,
      );
    },
  );

  it.each(NO_PICKER_PAGES)(
    "has no picker on %s, and Sessions sits directly above Agents",
    (path) => {
      pathname = path;
      renderLayout();
      expect(picker()).toBeUndefined();
      expect(screen.getAllByRole("link", { name: "Sessions" })).toHaveLength(1);
      expect(link("Sessions").getAttribute("href")).toBe("/sessions");
      // Next to each other in the same group, so nothing is between them.
      expect(link("Sessions").nextElementSibling).toBe(link("Agents"));
    },
  );

  it.each([...PICKER_PAGES, ...NO_PICKER_PAGES])(
    "has the other links on %s",
    (path) => {
      pathname = path;
      renderLayout();
      for (const name of [
        "Agents",
        "Skills",
        "Files/Memory",
        "Structural Data",
        "Errors",
        "Settings",
      ]) {
        expect(link(name)).toBeTruthy();
      }
    },
  );
});

describe("the navbar: the session list", () => {
  it.each(["/sessions", "/sessions/s1"])(
    "shows the session list on %s",
    async (path) => {
      pathname = path;
      renderLayout();
      expect(await screen.findByText("Lighthouse")).toBeTruthy();
    },
  );

  it.each([
    "/",
    "/agents",
    "/skills",
    "/files",
    "/errors",
    "/settings",
    "/projects/p1",
    "/projects/p1/agents",
  ])("hides the session list on %s", async (path) => {
    pathname = path;
    renderLayout();
    // Wait for the list query, so a list that is shown would be there.
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalled());
    expect(screen.queryByText("Lighthouse")).toBeNull();
  });
});

describe("the navbar: the project links", () => {
  beforeEach(() => {
    vi.spyOn(api, "listProjects").mockResolvedValue([project]);
    usePicked.setState({ projectId: "p1" });
  });

  const projectLinks = () =>
    screen.queryByRole("button", { name: "Project Links" });

  it.each(PICKER_PAGES)(
    "shows them with the picker on %s, when a project is picked",
    async (path) => {
      pathname = path;
      renderLayout();
      expect(
        await screen.findByRole("button", { name: "Project Links" }),
      ).toBeTruthy();
    },
  );

  it.each(NO_PICKER_PAGES)(
    "hides them on %s, even with a project picked",
    async (path) => {
      pathname = path;
      renderLayout();
      await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalled());
      // The picked project is still there: it is only the links that are hidden.
      expect(usePicked.getState().projectId).toBe("p1");
      expect(projectLinks()).toBeNull();
    },
  );

  it("shows none when no project is picked", async () => {
    usePicked.setState({ projectId: null });
    pathname = "/sessions";
    renderLayout();
    await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalled());
    expect(projectLinks()).toBeNull();
  });
});
