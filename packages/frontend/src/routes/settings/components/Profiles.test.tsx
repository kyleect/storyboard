import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ProfileListing, type ProfileView } from "../../../api";
import { Profiles } from "./Profiles";

const profile = (
  id: string,
  name: string,
  over: Partial<ProfileView> = {},
): ProfileView => ({
  id,
  name,
  createdAt: "2026-11-06T00:00:00Z",
  lastUsedAt: "2026-11-06T00:00:00Z",
  trashedAt: null,
  active: false,
  ...over,
});

function renderSection(over: Partial<ProfileListing> = {}) {
  const listing: ProfileListing = {
    active: "default",
    profiles: [
      profile("default", "Default", { active: true }),
      profile("w", "Work"),
    ],
    trashed: [],
    ...over,
  };

  vi.spyOn(api, "listProfiles").mockResolvedValue(listing);

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <Notifications />
        <Profiles />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

const row = (name: string) =>
  screen.getByText(name).closest(".mantine-Paper-root") as HTMLElement;
const inRow = (name: string, label: string) =>
  Array.from(row(name).querySelectorAll("button")).find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Profiles", () => {
  it("shows the profiles, the active one badged", async () => {
    renderSection();
    expect(await screen.findByText("Work")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("will not switch to, or trash, the active profile; Default cannot be trashed", async () => {
    renderSection({
      active: "w",
      profiles: [
        profile("default", "Default"),
        profile("w", "Work", { active: true }),
      ],
    });
    await screen.findByText("Work");
    expect(inRow("Work", "Switch to").disabled).toBe(true);
    expect(inRow("Work", "Trash").disabled).toBe(true);
    expect(inRow("Default", "Switch to").disabled).toBe(false);
    expect(inRow("Default", "Trash").disabled).toBe(true);
  });

  it("creates a profile from the typed name", async () => {
    const spy = vi
      .spyOn(api, "createProfile")
      .mockResolvedValue(profile("n", "Novel"));

    renderSection();
    await screen.findByText("Work");
    const create = screen.getByRole("button", { name: "Create" });

    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New profile"), {
      target: { value: "Novel" },
    });
    fireEvent.click(create);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("Novel"));
  });

  it("renames inline", async () => {
    const spy = vi
      .spyOn(api, "renameProfile")
      .mockResolvedValue(profile("w", "Job"));

    renderSection();
    await screen.findByText("Work");
    fireEvent.click(inRow("Work", "Rename"));
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Job" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("w", "Job"));
  });

  it("switches, and trashes and restores", async () => {
    const sw = vi.spyOn(api, "switchProfile").mockResolvedValue({} as never);
    const tr = vi
      .spyOn(api, "trashProfile")
      .mockResolvedValue(profile("w", "Work"));
    const re = vi
      .spyOn(api, "restoreProfile")
      .mockResolvedValue(profile("o", "Old"));

    renderSection({ trashed: [profile("o", "Old", { trashedAt: "x" })] });
    await screen.findByText("Work");
    fireEvent.click(inRow("Work", "Switch to"));
    await waitFor(() => expect(sw).toHaveBeenCalledWith("w"));
    fireEvent.click(inRow("Work", "Trash"));
    await waitFor(() => expect(tr).toHaveBeenCalledWith("w"));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(re).toHaveBeenCalledWith("o"));
  });

  it("shows why a switch was refused", async () => {
    vi.spyOn(api, "switchProfile").mockRejectedValue(
      new Error("A run is active in Chapter one"),
    );
    renderSection();
    await screen.findByText("Work");
    fireEvent.click(inRow("Work", "Switch to"));
    expect(await screen.findByText(/Chapter one/)).toBeTruthy();
  });
});
