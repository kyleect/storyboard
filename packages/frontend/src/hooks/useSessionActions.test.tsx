import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, type Session } from "../api";
import { useSessionActions } from "./useSessionActions";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({}),
}));

afterEach(() => vi.restoreAllMocks());

const session: Session = {
  id: "s1",
  title: "Plot",
  created_at: "2026-11-01T00:00:00Z",
  model: null,
  reasoning_effort: null,
  trashed_at: null,
  project_id: null,
  trashed_with_project: 0,
  agent_id: null,
  continued_from_id: null,
  continued_from_title: null,
  continued_carried: null,
};

function Trash() {
  const actions = useSessionActions();

  return (
    <button type="button" onClick={() => actions.confirmTrash(session)}>
      Trash it
    </button>
  );
}

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>
          <Trash />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Trash it" }));
}

const confirm = async (name: string) =>
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name }),
  );

const needsForce = () =>
  new ApiError("Later sessions continue this one.", 409, {
    needsForce: true,
    continuedBy: [
      { id: "s2", title: "Plot (2)" },
      { id: "s3", title: "Plot (3)" },
    ],
  });

describe("moving a session to the trash", () => {
  it("moves it with one confirmation when nothing continues it", async () => {
    const trash = vi.spyOn(api, "trashSession").mockResolvedValue(session);

    show();
    await confirm("Move to trash");
    await waitFor(() => expect(trash).toHaveBeenCalledWith("s1"));
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("names the sessions that continue it, and moves it only after a second confirmation", async () => {
    const trash = vi
      .spyOn(api, "trashSession")
      .mockRejectedValueOnce(needsForce())
      .mockResolvedValueOnce(session);

    show();
    await confirm("Move to trash");
    expect(
      await screen.findByText(/“Plot \(2\)”, “Plot \(3\)” continue/),
    ).toBeTruthy();
    expect(trash).toHaveBeenCalledTimes(1);

    await confirm("Move to trash anyway");
    await waitFor(() => expect(trash).toHaveBeenCalledTimes(2));
    expect(trash).toHaveBeenLastCalledWith("s1", true);
  });

  it("leaves it where it is when the second confirmation is cancelled", async () => {
    const trash = vi.spyOn(api, "trashSession").mockRejectedValue(needsForce());

    show();
    await confirm("Move to trash");
    await screen.findByText("Later sessions continue this one");
    await confirm("Cancel");
    await new Promise((r) => setTimeout(r, 20));
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("shows any other refusal as an error", async () => {
    const shown = vi.spyOn(notifications, "show").mockReturnValue("id");

    vi.spyOn(api, "trashSession").mockRejectedValue(
      new ApiError("A run is in progress in this session.", 409, {}),
    );
    show();
    await confirm("Move to trash");
    await waitFor(() =>
      expect(shown).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not move to trash",
          message: "A run is in progress in this session.",
        }),
      ),
    );
  });
});
