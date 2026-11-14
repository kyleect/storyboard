import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type DerivedText,
  type MediaDescriberInfo,
  type SettingsView,
} from "../../api";
import { DerivedTextField } from "./FileViews";
import { MediaDescriptions } from "../../routes/settings/components/MediaSettings";

afterEach(() => vi.restoreAllMocks());

function show(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <ModalsProvider>{ui}</ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

const info = (over: Partial<MediaDescriberInfo> = {}): MediaDescriberInfo => ({
  enabled: true,
  files: 3,
  empty: 2,
  ...over,
});

describe("DerivedTextField", () => {
  const setup = (derived: DerivedText, describer = info()) => {
    vi.spyOn(api, "getDerivedText").mockResolvedValue(derived);
    vi.spyOn(api, "getMediaDescriber").mockResolvedValue(describer);
    return show(<DerivedTextField hash="h1" />);
  };

  it("shows the text and says who wrote it", async () => {
    setup({ text: "A grey cat.", state: "generated" });
    expect(await screen.findByDisplayValue("A grey cat.")).toBeTruthy();
    expect(screen.getByText("Written by the Media Describer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Write again" })).toBeTruthy();
  });

  it("shows a failed generation as not generated, with Retry", async () => {
    const describe = vi
      .spyOn(api, "describeFile")
      .mockResolvedValue({ text: "", state: "pending" });
    setup({ text: "", state: "failed" });
    expect(await screen.findByText("Not generated.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(describe).toHaveBeenCalledWith("h1"));
    expect(await screen.findByText("Writing a description…")).toBeTruthy();
  });

  it("saves what the user types, and only when it changed", async () => {
    const set = vi
      .spyOn(api, "setDerivedText")
      .mockResolvedValue({ text: "My cat", state: "edited" });
    setup({ text: "", state: "none" });
    const box = await screen.findByLabelText(/Text for search/);
    expect(screen.queryByRole("button", { name: "Save text" })).toBeNull();
    fireEvent.change(box, { target: { value: "My cat" } });
    fireEvent.click(screen.getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("h1", "My cat"));
    expect(await screen.findByText("Edited by you.")).toBeTruthy();
  });

  it("cannot generate while descriptions are off, and says how to turn them on", async () => {
    setup({ text: "", state: "none" }, info({ enabled: false }));
    const button = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByText(/Choose a Media describer model/)).toBeTruthy();
  });
});

describe("MediaDescriptions settings", () => {
  const view = (model: string): SettingsView =>
    ({
      effective: {
        mediaDescriberAgent: "builtin-media-describer",
        mediaDescriberModel: model,
      },
      stored: {},
      overriddenByEnv: {},
    }) as unknown as SettingsView;

  const setup = (describer: MediaDescriberInfo, saved = "other") => {
    vi.spyOn(api, "listModels").mockResolvedValue([
      { id: "gemma" },
      { id: "other" },
    ] as never);
    vi.spyOn(api, "listAgents").mockResolvedValue([
      {
        id: "builtin-media-describer",
        name: "Media Describer",
        builtin: true,
        deleted: false,
      },
    ] as never);
    vi.spyOn(api, "saveSettings").mockResolvedValue(view(saved));
    vi.spyOn(api, "getMediaDescriber").mockResolvedValue(describer);
    return show(<MediaDescriptions view={view("gemma")} />);
  };

  it("saves without asking when nothing about who writes the text changed", async () => {
    setup(info(), "gemma");
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.getMediaDescriber).not.toHaveBeenCalled();
    expect(screen.queryByText(/Generate descriptions for/)).toBeNull();
  });

  it("asks first after a change, and fills only the empty ones when told to", async () => {
    const regenerate = vi
      .spyOn(api, "regenerateDescriptions")
      .mockResolvedValue({ queued: 2 });
    setup(info());
    // The server reports a different model in force after the save.
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Generate descriptions for 3 files?"),
    ).toBeTruthy();
    expect(screen.getByText(/2 of 3 have no text/)).toBeTruthy();
    // Saving alone writes nothing.
    expect(regenerate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Fill the 2 with no text" }),
    );
    await waitFor(() => expect(regenerate).toHaveBeenCalledWith("empty"));
  });

  it("can write all again, or leave things as they are", async () => {
    const regenerate = vi
      .spyOn(api, "regenerateDescriptions")
      .mockResolvedValue({ queued: 3 });
    setup(info());
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Write all again" }),
    );
    await waitFor(() => expect(regenerate).toHaveBeenCalledWith("all"));
  });

  it("does not ask when descriptions are off or there are no files", async () => {
    setup(info({ enabled: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.getMediaDescriber).toHaveBeenCalled());
    expect(screen.queryByText(/Generate descriptions for/)).toBeNull();
  });

  it("Not now leaves everything alone", async () => {
    const regenerate = vi.spyOn(api, "regenerateDescriptions");
    setup(info());
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByText(/Generate descriptions for/)).toBeNull(),
    );
    expect(regenerate).not.toHaveBeenCalled();
  });
});
