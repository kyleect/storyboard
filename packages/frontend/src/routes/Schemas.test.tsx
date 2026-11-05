import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SchemasPanel } from "./Schemas";

/* The schemas panel and builder (decisions 15, 44; plan P10, layout A). */

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModalsProvider>
          <SchemasPanel owner={{ scope: "global" }} />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SchemasPanel", () => {
  it("builds a schema from fields and saves its JSON Schema", async () => {
    vi.spyOn(api, "listSchemas").mockResolvedValue({
      readOnly: null,
      schemas: [],
    });
    const create = vi.spyOn(api, "createSchema").mockResolvedValue({
      id: "s1",
      name: "Note",
      description: "A note.",
      scope: "global",
      version: 1,
      copiedFrom: null,
      deleted: false,
    });
    vi.spyOn(api, "getSchema").mockRejectedValue(new Error("not needed"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New schema" }));
    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: "Note" },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "A note." },
    });

    fireEvent.click(screen.getByRole("button", { name: "+ Add field" }));
    // The new field is selected; its settings are on the right.
    expect(screen.getByText("Give the field a name.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const names = screen.getAllByLabelText(/^Name/);
    fireEvent.change(names[names.length - 1] as HTMLElement, {
      target: { value: "text" },
    });
    fireEvent.click(screen.getByLabelText("Required"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]?.[1]).toEqual({
      name: "Note",
      description: "A note.",
      body: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    });
  });

  it("switches to JSON and back, keeping the fields", async () => {
    vi.spyOn(api, "listSchemas").mockResolvedValue({
      readOnly: null,
      schemas: [],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "New schema" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add field" }));
    const names = screen.getAllByLabelText(/^Name/);
    fireEvent.change(names[names.length - 1] as HTMLElement, {
      target: { value: "title" },
    });
    fireEvent.click(screen.getByText("JSON"));
    expect(await screen.findByLabelText("JSON Schema")).toBeTruthy();
    fireEvent.click(screen.getByText("Builder"));
    expect(await screen.findByText("title")).toBeTruthy();
  });
});
