import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ProfileListing, type ProfileView } from "../api";
import { ProfileSwitcher } from "./ProfileSwitcher";

/* The profile menu at the bottom of the rail. */

const profile = (id: string, name: string, active = false): ProfileView => ({
  id,
  name,
  createdAt: "2026-11-06T00:00:00Z",
  lastUsedAt: "2026-11-06T00:00:00Z",
  trashedAt: null,
  active,
});

function renderSwitcher(onManage = () => {}) {
  const listing: ProfileListing = {
    active: "default",
    profiles: [profile("default", "Default", true), profile("w", "Work")],
    trashed: [],
  };
  vi.spyOn(api, "listProfiles").mockResolvedValue(listing);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ProfileSwitcher onManage={onManage} />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProfileSwitcher", () => {
  it("lists the profiles and marks the active one", async () => {
    renderSwitcher();
    fireEvent.click(screen.getByLabelText("Profile"));
    expect(await screen.findByText("Work")).toBeTruthy();
    const current = screen.getByText("Default").closest("button");
    expect(current?.getAttribute("aria-current")).toBe("true");
  });

  it("switches to another profile when it is picked", async () => {
    const spy = vi.spyOn(api, "switchProfile").mockResolvedValue({
      active: "w",
    } as never);
    renderSwitcher();
    fireEvent.click(screen.getByLabelText("Profile"));
    fireEvent.click(await screen.findByText("Work"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("w"));
  });

  it("does nothing when the active profile is picked", async () => {
    const spy = vi.spyOn(api, "switchProfile");
    renderSwitcher();
    fireEvent.click(screen.getByLabelText("Profile"));
    fireEvent.click(await screen.findByText("Default"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("opens the management page", async () => {
    const onManage = vi.fn();
    renderSwitcher(onManage);
    fireEvent.click(screen.getByLabelText("Profile"));
    fireEvent.click(await screen.findByText("Manage profiles…"));
    expect(onManage).toHaveBeenCalled();
  });
});
