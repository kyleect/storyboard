import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type SkillDetail,
  type SkillFileInfo,
  type SkillImportPreview,
  type SkillWithFiles,
} from "../../../api";
import { SkillsExplorer } from "./SkillsExplorer";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const at = "2026-11-13T10:00:00Z";
const info = (path: string): SkillFileInfo => ({
  path,
  mediaType: "text/markdown",
  size: 40,
  missing: false,
  hash: `h-${path}`,
});
const skill = (
  id: string,
  name: string,
  scope: SkillWithFiles["scope"] = "global",
  paths = ["SKILL.md"],
): SkillWithFiles => ({
  id,
  name,
  description: `About ${name}.`,
  scope,
  projectId: scope === "project" ? "p1" : null,
  agentId: null,
  version: 1,
  createdAt: at,
  updatedAt: at,
  deleted: false,
  files: paths.map(info),
});
const asDetail = (s: SkillWithFiles): SkillDetail => ({
  ...s,
  body: "",
  versions: [],
});

const SKILLS: Record<string, SkillWithFiles[]> = {
  global: [
    skill("b1", "builtin-tasks", "builtin"),
    skill("g1", "outline", "global", ["SKILL.md", "refs/guide.md"]),
  ],
  project: [skill("p1", "house-style", "project")],
};

function show(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider env="test">
        <ModalsProvider>{ui}</ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

function mockApi() {
  vi.spyOn(api, "listSkillTree").mockImplementation(async (o) =>
    (SKILLS[o.scope] ?? []).filter(Boolean),
  );
  vi.spyOn(api, "getSkill").mockImplementation(async (id) => {
    const s = Object.values(SKILLS)
      .flat()
      .find((k) => k.id === id);
    if (!s) throw new Error("not found");
    return asDetail(s);
  });
  vi.spyOn(api, "getSkillFile").mockImplementation(async (_id, path) => ({
    ...info(path),
    value: `text of ${path}`,
  }));
}

async function menuOf(label: string) {
  fireEvent.contextMenu(await screen.findByText(label));
}

describe("SkillsExplorer", () => {
  it("shows Built-in and Global on the global page, skills as folders", async () => {
    mockApi();
    show(<SkillsExplorer />);
    expect(await screen.findByText("Built-in")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.getByText("builtin-tasks")).toBeTruthy();
    expect(screen.getByText("outline")).toBeTruthy();
  });

  it("adds a Project root on a project's page", async () => {
    mockApi();
    show(<SkillsExplorer projectId="p1" />);
    expect(await screen.findByText("Project")).toBeTruthy();
    expect(screen.getByText("house-style")).toBeTruthy();
  });

  it("opens a skill's SKILL.md in a tab", async () => {
    mockApi();
    show(<SkillsExplorer />);
    fireEvent.click(await screen.findByText("outline"));
    fireEvent.click(
      await screen.findByText("SKILL.md", { selector: "span,p,div" }),
    );
    await waitFor(() =>
      expect(api.getSkillFile).toHaveBeenCalledWith("g1", "SKILL.md"),
    );
  });

  it("exports a skill as a zip from its menu", async () => {
    mockApi();
    const exported = vi
      .spyOn(api, "exportSkill")
      .mockResolvedValue(new Blob(["zip"]));
    URL.createObjectURL = vi.fn(() => "blob:zip");
    URL.revokeObjectURL = vi.fn();
    show(<SkillsExplorer />);
    await menuOf("outline");
    fireEvent.click(await screen.findByText("Export as zip"));
    await waitFor(() => expect(exported).toHaveBeenCalledWith("g1"));
  });

  it("offers Export and Copy on a built-in skill, but not New file", async () => {
    mockApi();
    show(<SkillsExplorer />);
    await menuOf("builtin-tasks");
    expect(await screen.findByText("Export as zip")).toBeTruthy();
    expect(screen.getByText("Copy to Global")).toBeTruthy();
    expect(screen.queryByText("New file here")).toBeNull();
  });

  it("copies a built-in skill to Global", async () => {
    mockApi();
    const copy = vi
      .spyOn(api, "copySkill")
      .mockResolvedValue(asDetail(skill("g2", "builtin-tasks")));
    show(<SkillsExplorer />);
    await menuOf("builtin-tasks");
    fireEvent.click(await screen.findByText("Copy to Global"));
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith({ scope: "global" }, "b1"),
    );
  });

  it("copies a global skill into the project on a project's page", async () => {
    mockApi();
    const copy = vi
      .spyOn(api, "copySkill")
      .mockResolvedValue(asDetail(skill("p2", "outline", "project")));
    show(<SkillsExplorer projectId="p1" />);
    await menuOf("outline");
    fireEvent.click(await screen.findByText("Copy to this project"));
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith({ scope: "project", id: "p1" }, "g1"),
    );
  });
});

describe("importing a skill", () => {
  const preview = (
    over: Partial<SkillImportPreview> = {},
  ): SkillImportPreview => ({
    name: "new-skill",
    description: "Use when new.",
    instructions: "Do.",
    files: [
      { path: "SKILL.md", size: 50 },
      { path: "refs/a.md", size: 2048 },
    ],
    warnings: [],
    clash: null,
    ...over,
  });

  async function pickZip() {
    show(<SkillsExplorer />);
    const input = await screen.findByTestId("import-zip");
    const file = new File(["zip"], "new-skill.zip", {
      type: "application/zip",
    });
    fireEvent.change(input, { target: { files: [file] } });
    return file;
  }

  it("shows what is in the zip before importing it", async () => {
    mockApi();
    const prev = vi
      .spyOn(api, "previewSkillImport")
      .mockResolvedValue(preview());
    const imp = vi.spyOn(api, "importSkill").mockResolvedValue({
      ...asDetail(skill("g3", "new-skill")),
      warnings: [],
    });
    const file = await pickZip();
    expect(await screen.findByText("new-skill")).toBeTruthy();
    expect(screen.getByText("refs/a.md")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect(prev).toHaveBeenCalledWith({ scope: "global" }, file);
    expect(imp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(imp).toHaveBeenCalledWith({ scope: "global" }, file),
    );
  });

  it("asks what to do when the name is taken: replace", async () => {
    mockApi();
    vi.spyOn(api, "previewSkillImport").mockResolvedValue(
      preview({ clash: { id: "g1", deleted: false } }),
    );
    const imp = vi.spyOn(api, "importSkill").mockResolvedValue({
      ...asDetail(skill("g1", "new-skill")),
      warnings: [],
    });
    const file = await pickZip();
    await screen.findByText(/already exists here/);
    const go = screen.getByRole("button", { name: "Import" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Replace it/));
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(go);
    await waitFor(() =>
      expect(imp).toHaveBeenCalledWith({ scope: "global" }, file, {
        resolve: "replace",
      }),
    );
  });

  it("asks what to do when the name is taken: another name", async () => {
    mockApi();
    vi.spyOn(api, "previewSkillImport").mockResolvedValue(
      preview({ clash: { id: "g1", deleted: false } }),
    );
    const imp = vi.spyOn(api, "importSkill").mockResolvedValue({
      ...asDetail(skill("g4", "other-name")),
      warnings: [],
    });
    const file = await pickZip();
    await screen.findByText(/already exists here/);
    fireEvent.change(screen.getByLabelText("New name"), {
      target: { value: "other-name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(imp).toHaveBeenCalledWith({ scope: "global" }, file, {
        resolve: "rename",
        name: "other-name",
      }),
    );
  });

  it("cannot replace a deleted skill, and says to restore it", async () => {
    mockApi();
    vi.spyOn(api, "previewSkillImport").mockResolvedValue(
      preview({ clash: { id: "g1", deleted: true } }),
    );
    await pickZip();
    await screen.findByText(/was deleted here/);
    expect(
      (screen.getByLabelText(/Replace it/) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows why a zip cannot be read, and imports nothing", async () => {
    mockApi();
    vi.spyOn(api, "previewSkillImport").mockRejectedValue(
      new Error("The zip has no SKILL.md at its top level."),
    );
    const imp = vi.spyOn(api, "importSkill");
    await pickZip();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/no SKILL\.md/)).toBeTruthy();
    expect(imp).not.toHaveBeenCalled();
  });
});
