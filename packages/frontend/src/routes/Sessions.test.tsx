import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type SessionTableItem } from "../api";
import { sessionKeys } from "../queries";
import { useSessionsPrefs } from "../sessionsPrefs";
import { SessionsPage } from "./Sessions";

/* The Sessions page (Sessions page plan, section 4). */

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
  useNavigate: () => () => {},
  useParams: () => ({}),
}));

beforeEach(() => {
  localStorage.clear();
  useSessionsPrefs.setState({ direction: "desc", pageSize: 10 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const item = (
  n: number,
  over: Partial<SessionTableItem> = {},
): SessionTableItem => ({
  id: `s${n}`,
  title: `Session ${n}`,
  created_at: new Date(Date.UTC(2026, 10, n, 10)).toISOString(),
  model: null,
  reasoning_effort: null,
  trashed_at: null,
  project_id: null,
  trashed_with_project: 0,
  agent_id: null,
  usage: null,
  agents: [],
  running: false,
  unread: false,
  ...over,
});

function renderPage(projectId: string | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const page = (id: string | null) => (
    <MantineProvider>
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>
          <SessionsPage projectId={id} />
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  );
  const { rerender } = render(page(projectId));
  return {
    queryClient,
    showProject: (id: string | null) => rerender(page(id)),
  };
}

const box = (name: string) =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

const lastRequest = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.at(-1)?.[0];

/** The page-size input; Mantine labels its option list the same way. */
const perPage = () =>
  screen
    .getAllByLabelText("Sessions per page")
    .find((el) => el.tagName === "INPUT") as HTMLElement;

describe("the Sessions page: the table", () => {
  it("lists the sessions with their columns", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [
        item(2, { agents: [{ id: "a1", name: "Editor" }] }),
        item(1, {
          agents: [
            { id: "a2", name: "Lead" },
            { id: "a3", name: "Helper" },
          ],
        }),
        item(3),
      ],
      total: 3,
    });
    renderPage();

    expect(await screen.findByText("Session 2")).toBeTruthy();
    expect(
      screen.getByText("Session 2").closest("a")?.getAttribute("href"),
    ).toBe("/sessions/s2");
    expect(screen.getByText("Editor")).toBeTruthy();
    expect(screen.getByText("Lead")).toBeTruthy();
    expect(screen.getByText("Helper")).toBeTruthy();
    expect(
      screen.getByText(new Date(item(2).created_at).toLocaleString()),
    ).toBeTruthy();
    // No agent, no usage: a dash for each.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/3 sessions/)).toBeTruthy();
  });

  it("asks for newest first, page 1, 10 a page, for no project", async () => {
    const spy = vi
      .spyOn(api, "listSessionsPage")
      .mockResolvedValue({ items: [item(1)], total: 1 });
    renderPage();
    await screen.findByText("Session 1");
    expect(lastRequest(spy)).toEqual({
      projectId: null,
      direction: "desc",
      page: 1,
      pageSize: 10,
    });
  });

  it("says when there are no sessions", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [],
      total: 0,
    });
    renderPage();
    expect(await screen.findByText("No sessions.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an error from the backend", async () => {
    vi.spyOn(api, "listSessionsPage").mockRejectedValue(new Error("Boom"));
    renderPage();
    expect(await screen.findByText("Boom")).toBeTruthy();
  });

  it("has a menu with Rename and Move to trash on each row", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 1,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Session 1" }),
    );
    expect(await screen.findByText("Rename")).toBeTruthy();
    expect(screen.getAllByText("Move to trash").length).toBeGreaterThan(0);
  });
});

describe("the Sessions page: sorting", () => {
  it("flips the direction from the Created header, and goes back to page 1", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 25,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 2 }));

    fireEvent.click(
      screen.getByRole("button", { name: /Created, sorted newest first/ }),
    );
    await waitFor(() =>
      expect(lastRequest(spy)).toMatchObject({ direction: "asc", page: 1 }),
    );
    expect(
      screen.getByRole("button", { name: /Created, sorted oldest first/ }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("columnheader", { name: /Created/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");

    fireEvent.click(
      screen.getByRole("button", { name: /Created, sorted oldest first/ }),
    );
    await waitFor(() =>
      expect(lastRequest(spy)).toMatchObject({ direction: "desc" }),
    );
  });

  it("remembers the direction", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 1,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(
      screen.getByRole("button", { name: /Created, sorted newest first/ }),
    );
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("harness.sessionsPrefs") ?? "{}"),
      ).toMatchObject({ direction: "asc" }),
    );
  });

  it("starts from the remembered direction and page size", async () => {
    localStorage.setItem(
      "harness.sessionsPrefs",
      JSON.stringify({ direction: "asc", pageSize: 50 }),
    );
    // A fresh store reads localStorage when it is created.
    vi.resetModules();
    const { useSessionsPrefs: fresh } = await import("../sessionsPrefs");
    expect(fresh.getState()).toMatchObject({ direction: "asc", pageSize: 50 });
  });

  it("ignores remembered values it does not know", async () => {
    localStorage.setItem(
      "harness.sessionsPrefs",
      JSON.stringify({ direction: "sideways", pageSize: 7 }),
    );
    vi.resetModules();
    const { useSessionsPrefs: fresh } = await import("../sessionsPrefs");
    expect(fresh.getState()).toMatchObject({ direction: "desc", pageSize: 10 });

    localStorage.setItem("harness.sessionsPrefs", "not json");
    vi.resetModules();
    const again = await import("../sessionsPrefs");
    expect(again.useSessionsPrefs.getState()).toMatchObject({
      direction: "desc",
      pageSize: 10,
    });
  });
});

describe("the Sessions page: paging", () => {
  it("pages through the sessions", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 25,
    });
    renderPage();
    await screen.findByText("Session 1");
    // 25 sessions, 10 a page: three pages.
    expect(screen.getByRole("button", { name: "3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "4" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 3 }));
  });

  it("shows no page buttons when everything fits on one page", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 10,
    });
    renderPage();
    await screen.findByText("Session 1");
    expect(screen.queryByRole("button", { name: "2" })).toBeNull();
  });

  it("changes the page size, goes back to page 1, and remembers it", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 120,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 2 }));

    fireEvent.click(perPage());
    fireEvent.click(
      await screen.findByRole("option", { name: "50", hidden: true }),
    );
    await waitFor(() =>
      expect(lastRequest(spy)).toMatchObject({ pageSize: 50, page: 1 }),
    );
    expect(
      JSON.parse(localStorage.getItem("harness.sessionsPrefs") ?? "{}"),
    ).toMatchObject({ pageSize: 50 });
  });

  it("offers 10, 25, 50 and 100 a page", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 1,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(perPage());
    const options = await screen.findAllByRole("option", { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual([
      "10",
      "25",
      "50",
      "100",
    ]);
  });

  it("goes back to the last page when there are fewer sessions than before", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 15,
    });
    const { queryClient } = renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 2 }));

    // Everything on page 2 was trashed: 5 sessions are left, one page.
    spy.mockResolvedValue({ items: [item(1)], total: 5 });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: sessionKeys.lists() });
    });
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 1 }));
  });
});

describe("the Sessions page: selecting", () => {
  const twoRows = () =>
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(2), item(1)],
      total: 2,
    });

  it("selects and unselects rows", async () => {
    twoRows();
    renderPage();
    await screen.findByText("Session 1");
    expect(screen.getByText("0 selected")).toBeTruthy();

    fireEvent.click(box("Select Session 1"));
    expect(box("Select Session 1").checked).toBe(true);
    expect(box("Select Session 2").checked).toBe(false);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(box("Select all sessions").indeterminate).toBe(true);

    fireEvent.click(box("Select Session 1"));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(box("Select all sessions").indeterminate).toBe(false);
  });

  it("selects every session of the project, on every page, from the header", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(2), item(1)],
      total: 5,
    });
    const ids = vi.spyOn(api, "listSessionIds").mockResolvedValue({
      sessions: ["s1", "s2", "s3", "s4", "s5"].map((id) => ({
        id,
        running: false,
      })),
    });
    renderPage();
    await screen.findByText("Session 1");

    fireEvent.click(box("Select all sessions"));
    expect(await screen.findByText("5 selected")).toBeTruthy();
    expect(ids).toHaveBeenCalledWith(null);
    expect(box("Select all sessions").checked).toBe(true);
    expect(box("Select Session 1").checked).toBe(true);
    expect(box("Select Session 2").checked).toBe(true);

    // Unticking one leaves the rest selected, and the header unticked.
    fireEvent.click(box("Select Session 2"));
    expect(screen.getByText("4 selected")).toBeTruthy();
    expect(box("Select all sessions").checked).toBe(false);
    expect(box("Select all sessions").indeterminate).toBe(true);

    // Ticking it again selects everything again.
    fireEvent.click(box("Select all sessions"));
    expect(await screen.findByText("5 selected")).toBeTruthy();

    // With everything selected, the header clears the selection.
    fireEvent.click(box("Select all sessions"));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("leaves out running sessions when selecting everything", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(2), item(1)],
      total: 3,
    });
    vi.spyOn(api, "listSessionIds").mockResolvedValue({
      sessions: [
        { id: "s1", running: false },
        { id: "s2", running: false },
        { id: "s3", running: true },
      ],
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select all sessions"));
    expect(await screen.findByText("2 selected")).toBeTruthy();
    // Everything that could be selected is, so the header shows it.
    expect(box("Select all sessions").checked).toBe(true);
  });

  it("disables the checkbox of a running session", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(2, { running: true }), item(1)],
      total: 2,
    });
    renderPage();
    await screen.findByText("Session 1");
    expect(box("Select Session 2").disabled).toBe(true);
    expect(box("Select Session 1").disabled).toBe(false);
  });

  it("keeps the selection when going to another page", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 25,
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 2 }));
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("clears the selection from its button", async () => {
    twoRows();
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(box("Select Session 1").checked).toBe(false);
  });

  it("reports when the sessions could not be listed", async () => {
    twoRows();
    vi.spyOn(api, "listSessionIds").mockRejectedValue(new Error("Nope"));
    const show = vi.spyOn(notifications, "show");
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select all sessions"));
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not select the sessions",
          message: "Nope",
        }),
      ),
    );
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("starts over when another project is picked", async () => {
    const spy = vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 25,
    });
    const { showProject } = renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(lastRequest(spy)).toMatchObject({ page: 2 }));
    fireEvent.click(box("Select Session 1"));
    expect(screen.getByText("1 selected")).toBeTruthy();

    act(() => showProject("p1"));
    await waitFor(() =>
      expect(lastRequest(spy)).toEqual({
        projectId: "p1",
        direction: "desc",
        page: 1,
        pageSize: 10,
      }),
    );
    expect(await screen.findByText("0 selected")).toBeTruthy();
  });

  it("selects the project's sessions, not the standalone ones", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 1,
    });
    const ids = vi.spyOn(api, "listSessionIds").mockResolvedValue({
      sessions: [{ id: "s1", running: false }],
    });
    renderPage("p1");
    await screen.findByText("Session 1");
    fireEvent.click(box("Select all sessions"));
    await screen.findByText("1 selected");
    expect(ids).toHaveBeenCalledWith("p1");
  });
});

describe("the Sessions page: moving to the trash", () => {
  const rows = () =>
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(3), item(2), item(1)],
      total: 3,
    });

  const confirmButton = async () =>
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Move to trash",
    });

  it("does nothing until something is selected", async () => {
    rows();
    renderPage();
    await screen.findByText("Session 1");
    const button = screen.getByRole("button", {
      name: "Move to trash",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Clear selection",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("asks first, then moves the selected sessions and clears the selection", async () => {
    const list = rows();
    const trash = vi.spyOn(api, "trashSessions").mockResolvedValue({
      trashed: ["s1", "s2"],
      refused: [],
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(box("Select Session 2"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Move 2 sessions to trash?")).toBeTruthy();
    expect(trash).not.toHaveBeenCalled();

    const callsBefore = list.mock.calls.length;
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(trash).toHaveBeenCalledWith(["s1", "s2"]));
    expect(await screen.findByText("0 selected")).toBeTruthy();
    // The table is fetched again.
    await waitFor(() =>
      expect(list.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("uses the singular for one session", async () => {
    rows();
    vi.spyOn(api, "trashSessions").mockResolvedValue({
      trashed: ["s1"],
      refused: [],
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    expect(await screen.findByText("Move 1 session to trash?")).toBeTruthy();
  });

  it("moves nothing when the dialog is cancelled", async () => {
    rows();
    const trash = vi.spyOn(api, "trashSessions");
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trash).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("sends every selected id, including those from other pages", async () => {
    vi.spyOn(api, "listSessionsPage").mockResolvedValue({
      items: [item(1)],
      total: 4,
    });
    vi.spyOn(api, "listSessionIds").mockResolvedValue({
      sessions: ["s1", "s2", "s3", "s4"].map((id) => ({ id, running: false })),
    });
    const trash = vi.spyOn(api, "trashSessions").mockResolvedValue({
      trashed: ["s1", "s2", "s3", "s4"],
      refused: [],
    });
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select all sessions"));
    await screen.findByText("4 selected");
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.click(await confirmButton());
    await waitFor(() =>
      expect(trash).toHaveBeenCalledWith(["s1", "s2", "s3", "s4"]),
    );
  });

  it("says which sessions were not moved, and why", async () => {
    rows();
    vi.spyOn(api, "trashSessions").mockResolvedValue({
      trashed: ["s1"],
      refused: [
        { id: "s2", error: "A run is in progress in this session." },
        { id: "s3", error: "A run is in progress in this session." },
      ],
    });
    const show = vi.spyOn(notifications, "show");
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(box("Select Session 2"));
    fireEvent.click(box("Select Session 3"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.click(await confirmButton());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "2 sessions were not moved",
          message: "A run is in progress in this session.",
        }),
      ),
    );
  });

  it("uses the singular when one session was not moved", async () => {
    rows();
    vi.spyOn(api, "trashSessions").mockResolvedValue({
      trashed: [],
      refused: [{ id: "s1", error: "The session is already in the trash." }],
    });
    const show = vi.spyOn(notifications, "show");
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.click(await confirmButton());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({ title: "1 session was not moved" }),
      ),
    );
  });

  it("reports an error from the backend and keeps the selection", async () => {
    rows();
    vi.spyOn(api, "trashSessions").mockRejectedValue(new Error("Disk full"));
    const show = vi.spyOn(notifications, "show");
    renderPage();
    await screen.findByText("Session 1");
    fireEvent.click(box("Select Session 1"));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));
    fireEvent.click(await confirmButton());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not move to trash",
          message: "Disk full",
        }),
      ),
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
});
