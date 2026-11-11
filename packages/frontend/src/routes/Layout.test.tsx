import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type ActiveRun,
  type Project,
  type SessionListItem,
} from "../api";
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
  vi.spyOn(api, "listActiveRuns").mockResolvedValue({ runs: [] });
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
        "Structured Data",
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

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId: "r1",
  sessionId: "s1",
  sessionTitle: "Lighthouse",
  parentRunId: null,
  agentName: "Editor",
  waiting: false,
  ...over,
});

const activeRuns = (...runs: ActiveRun[]) =>
  vi.spyOn(api, "listActiveRuns").mockResolvedValue({ runs });

/** The session's row in the list; its name includes what the row shows. */
const row = () => screen.getByRole("link", { name: /Lighthouse/ });

describe("the navbar: activity indicators", () => {
  it("shows nothing when no run is in progress", async () => {
    pathname = "/sessions";
    renderLayout();
    await screen.findByText("Lighthouse");
    await vi.waitFor(() => expect(api.listActiveRuns).toHaveBeenCalled());
    expect(screen.queryByLabelText("Agent activity")).toBeNull();
    expect(
      screen.queryByRole("img", { name: "An agent is working" }),
    ).toBeNull();
    expect(screen.queryByRole("img", { name: "Waiting for you" })).toBeNull();
  });

  it("puts a spinner on the row of a session with a run working", async () => {
    activeRuns(run());
    pathname = "/sessions";
    renderLayout();
    // The spinner is debounced, so it appears a moment after the run does.
    const spinner = await within(
      await screen.findByRole("link", { name: /Lighthouse/ }),
    ).findByRole("img", { name: "An agent is working" });
    expect(spinner).toBeTruthy();
  });

  it("puts the waiting badge on the row at once, with no spinner", async () => {
    activeRuns(run({ waiting: true }));
    pathname = "/sessions";
    renderLayout();
    await screen.findByText("Lighthouse");
    const badge = await within(row()).findByRole("img", {
      name: "Waiting for you",
    });
    expect(badge).toBeTruthy();
    expect(
      within(row()).queryByRole("img", { name: "An agent is working" }),
    ).toBeNull();
  });

  it("marks only the session that has a run", async () => {
    vi.spyOn(api, "listSessions").mockResolvedValue([
      session,
      { ...session, id: "s2", title: "Quiet one" },
    ]);
    activeRuns(run({ waiting: true }));
    pathname = "/sessions";
    renderLayout();
    await within(
      await screen.findByRole("link", { name: /Lighthouse/ }),
    ).findByRole("img", { name: "Waiting for you" });
    const quiet = screen.getByRole("link", { name: /Quiet one/ });
    expect(within(quiet).queryByRole("img")).toBeNull();
  });

  it("counts the runs in the header, subagents included", async () => {
    activeRuns(
      run(),
      run({ runId: "r2", parentRunId: "r1", agentName: "Proofreader" }),
    );
    pathname = "/sessions";
    renderLayout();
    const button = await screen.findByLabelText("Agent activity");
    expect(await within(button).findByText("2 agents working")).toBeTruthy();
    // Announced to screen readers too.
    expect((await screen.findByRole("status")).textContent).toBe(
      "2 agents working",
    );
  });

  it("counts a run in a session the list does not show, and lists it", async () => {
    activeRuns(
      run({
        sessionId: "elsewhere",
        sessionTitle: "Other project",
        runId: "r9",
      }),
    );
    pathname = "/sessions";
    renderLayout();
    const button = await screen.findByLabelText("Agent activity");
    expect(await within(button).findByText("1 agent working")).toBeTruthy();

    button.click();
    expect(await screen.findByText("Other project")).toBeTruthy();
    expect(screen.getByText(/Editor/)).toBeTruthy();
  });

  it("shows how many runs wait for the user in the header", async () => {
    activeRuns(run({ waiting: true }));
    pathname = "/sessions";
    renderLayout();
    const button = await screen.findByLabelText("Agent activity");
    expect(within(button).getByText("1 waiting")).toBeTruthy();
    expect(within(button).queryByText(/working/)).toBeNull();
  });
});
