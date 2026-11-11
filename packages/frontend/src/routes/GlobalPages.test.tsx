import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalEntriesPage } from "./EntriesPages";
import { GlobalStructuredDataPage } from "./StructuredDataPages";

/*
 * The global Files & memory and Structured Data pages are what the workbench
 * tab says they are: no heading and no help text above them.
 */

vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useParams: () => ({}),
  useNavigate: () => () => {},
}));
vi.mock("./FilesExplorer", () => ({
  FilesExplorer: () => <div>files explorer</div>,
}));
vi.mock("./Entries", () => ({ NotesPanel: () => <div>notes</div> }));
vi.mock("./StructuredExplorer", () => ({
  StructuredExplorer: () => <div>structured explorer</div>,
}));

const show = (page: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>{page}</MantineProvider>
    </QueryClientProvider>,
  );

describe("the global pages", () => {
  it("Files & memory is the Files and Memory tabs and nothing above them", () => {
    show(<GlobalEntriesPage />);
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Memory" })).toBeTruthy();
    expect(screen.getByText("files explorer")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText(/every session sees these/)).toBeNull();
  });

  it("Structured Data is the explorer and nothing above it", () => {
    show(<GlobalStructuredDataPage />);
    expect(screen.getByText("structured explorer")).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByText(/every session can use these/)).toBeNull();
  });
});
