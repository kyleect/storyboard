import { EditorView } from "@codemirror/view";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaInfo } from "@harness/core";
import {
  api,
  type DataDetail,
  type DataItem,
  type DataOwner,
  type FileScope,
  type SchemaDetail,
} from "../../api";
import { projectKeys } from "../../queries";
import { StructuredExplorer, StructuredRoots } from "./StructuredExplorer";
import type { StructuredRoot } from "../../lib/structured-explorer";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
beforeEach(() => localStorage.clear());

const must = <T,>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};

const session: FileScope = { scope: "session", id: "s1" };
const project: FileScope = { scope: "project", id: "p1" };
const global: FileScope = { scope: "global" };

const schema = (
  id: string,
  name: string,
  scope: SchemaInfo["scope"],
  extra: Partial<SchemaInfo> = {},
): SchemaInfo => ({
  id,
  name,
  description: `${name} schema`,
  scope,
  version: 1,
  copiedFrom: null,
  deleted: false,
  ...extra,
});

const CHARACTER = schema("sc", "Character", "session");
const PLACE = schema("sp", "Place", "project");
const SETTING = schema("sg", "Setting", "global");
const BUILTIN = schema("sb", "Note", "builtin");

const BODY = {
  type: "object",
  properties: {
    nickname: { type: "string", title: "Nickname" },
    hp: { type: "integer", title: "Hit points" },
  },
  required: ["nickname"],
};
const BODY_V2 = {
  ...BODY,
  properties: { ...BODY.properties, mood: { type: "string", title: "Mood" } },
};

const data = (
  id: string,
  name: string,
  schemaId: string,
  scope: DataItem["scope"],
  extra: Partial<DataItem> = {},
): DataItem => ({
  id,
  name,
  description: `${name} data`,
  scope,
  schemaId,
  schemaVersion: 1,
  latestVersion: 1,
  outOfDate: false,
  schemaInScope: true,
  deleted: false,
  ...extra,
});

const ARIA = data("d1", "Aria", "sc", "session");
const COVE = data("d2", "Cove", "sg", "session");
const HARBOUR = data("d3", "Harbour", "sg", "global");
const LOST = data("d4", "Lost", "gone", "session", { schemaInScope: false });
const VALUES: Record<string, unknown> = {
  d1: { nickname: "Ari", hp: 7 },
  d2: { nickname: "The Cove" },
  d3: { nickname: "The Harbour" },
};

const ALL = [CHARACTER, PLACE, SETTING, BUILTIN];
const USABLE: Record<string, SchemaInfo[]> = {
  session: [CHARACTER, PLACE, SETTING],
  project: [PLACE, SETTING],
  global: [SETTING, BUILTIN],
};
const OWN: Record<string, SchemaInfo[]> = {
  session: [CHARACTER],
  project: [PLACE],
  global: [SETTING, BUILTIN],
};
const DATA: Record<string, DataItem[]> = {
  session: [ARIA, COVE, LOST],
  project: [],
  global: [HARBOUR],
};

const owner = (o: DataOwner) => o.scope;

const schemaDetail = (s: SchemaInfo, body: unknown = BODY): SchemaDetail => ({
  ...s,
  body,
  versions: [{ version: 1, body }],
  dataCount: 2,
});

const dataDetail = (d: DataItem): DataDetail => {
  const s = ALL.find((x) => x.id === d.schemaId);
  return {
    ...d,
    value: VALUES[d.id],
    latestErrors: [],
    schema: s ? { ...s, pinned: BODY, latest: BODY } : null,
    versions: [],
  } as DataDetail;
};

function show(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MantineProvider env="test">
          <ModalsProvider>{ui}</ModalsProvider>
        </MantineProvider>
      </QueryClientProvider>,
    ),
  };
}

function typeInEditor(text: string) {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  if (!dom) throw new Error("no editor is open");
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error("no editor view");
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}
const editorText = () => {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no editor view");
  return view.state.doc.toString();
};

function mockApi() {
  vi.spyOn(api, "dataSchemas").mockImplementation(
    async (o) => USABLE[owner(o)] ?? [],
  );
  vi.spyOn(api, "listSchemas").mockImplementation(async (o) => ({
    readOnly: null,
    schemas: OWN[owner(o)] ?? [],
  }));
  vi.spyOn(api, "listData").mockImplementation(async (o) => ({
    readOnly: null,
    data: DATA[owner(o)] ?? [],
  }));
  vi.spyOn(api, "getSchema").mockImplementation(async (_o, id) => {
    const s = ALL.find((x) => x.id === id);
    if (!s) throw new Error("not found");
    return schemaDetail(s);
  });
  vi.spyOn(api, "schemaBody").mockResolvedValue(BODY);
  vi.spyOn(api, "getData").mockImplementation(async (_o, id) => {
    const d = [...(DATA.session ?? []), ...(DATA.global ?? [])].find(
      (x) => x.id === id,
    );
    if (!d) throw new Error("not found");
    return dataDetail(d);
  });
}

describe("the tree", () => {
  beforeEach(mockApi);

  it("has a root for each scope, each with a Schemas folder, schemas and their data", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    expect(await screen.findByText("Session")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Global")).toBeTruthy();
    expect(screen.getAllByText("Schemas")).toHaveLength(3);
    expect(await screen.findByText("Character")).toBeTruthy();
    expect(screen.queryByText("Aria")).toBeNull();
  });

  it("shows only Global on the global page, and Project and Global on a project page", async () => {
    const first = show(<StructuredExplorer page={global} />);
    await screen.findByText("Setting");
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    first.unmount();
    show(<StructuredExplorer page={project} />);
    await screen.findByText("Place");
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.getByText("Global")).toBeTruthy();
  });

  it("shows a higher scope's schema in the lower tree as inherited, with a tooltip", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    const inherited = screen.getAllByTestId("inherited-schema");
    expect(inherited.map((e) => e.textContent).sort()).toEqual([
      "Place",
      "Setting",
      "Setting",
    ]);
    expect(screen.getAllByLabelText("Inherited schema")).toHaveLength(3);
    fireEvent.mouseEnter(
      must(inherited.find((e) => e.textContent === "Place")),
    );
    expect(await screen.findByText(/Inherited from Project/)).toBeTruthy();
  });

  it("lists the data of a root under an inherited schema", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(must(screen.getAllByText("Setting")[0]));
    expect(await screen.findByText("Cove")).toBeTruthy();
    expect(screen.queryByText("Harbour")).toBeNull();
  });

  it("puts data whose schema is not available under Unknown schema", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Unknown schema"));
    expect(await screen.findByText("Lost")).toBeTruthy();
  });

  it("asks for deleted items when Show deleted is turned on", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    const list = vi.mocked(api.listData);
    expect(list.mock.calls.every(([, deleted]) => deleted === false)).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show deleted" }));
    await waitFor(() =>
      expect(list.mock.calls.some(([, deleted]) => deleted === true)).toBe(
        true,
      ),
    );
    expect(
      vi
        .mocked(api.listSchemas)
        .mock.calls.some(([, deleted]) => deleted === true),
    ).toBe(true);
  });

  it("says why when the lists cannot be loaded", async () => {
    vi.spyOn(api, "dataSchemas").mockRejectedValue(new Error("no backend"));
    vi.spyOn(api, "listSchemas").mockRejectedValue(new Error("no backend"));
    vi.spyOn(api, "listData").mockRejectedValue(new Error("no backend"));
    show(<StructuredExplorer page={session} projectId="p1" />);
    expect(await screen.findByText("no backend")).toBeTruthy();
  });
});

describe("opening", () => {
  beforeEach(mockApi);

  it("opens a schema on a click, as a form with its name, description and fields", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    expect(
      ((await screen.findByLabelText(/^Name/)) as HTMLInputElement).value,
    ).toBe("Character");
    expect(
      (screen.getByLabelText(/^Description/) as HTMLTextAreaElement).value,
    ).toBe("Character schema");
    expect(await screen.findByText("nickname")).toBeTruthy();
    expect(screen.getByRole("tab").getAttribute("title")).toContain(
      "Session › Schemas › Character",
    );
  });

  it("shows the project's color on the tab of a project's schema, and not on another", async () => {
    const { client } = show(<StructuredExplorer page={project} />);
    client.setQueryData(projectKeys.list(), [
      { id: "p1", name: "Novel", color: "teal" },
    ]);
    const iconBg = (tab: HTMLElement) =>
      (
        tab.querySelector(".mantine-ThemeIcon-root") as HTMLElement
      ).style.getPropertyValue("--ti-bg");

    fireEvent.doubleClick(await screen.findByText("Place"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Place/ })).toBeTruthy(),
    );
    const tab = screen.getByRole("tab", { name: /Place/ });
    expect(tab.getAttribute("title")).toContain("Project");
    expect(iconBg(tab)).toContain("--mantine-color-teal-filled");
    expect(tab.style.borderTop).toContain("--mantine-color-teal-filled");

    const globalTab = () =>
      screen
        .getAllByRole("tab")
        .find((t) => t.getAttribute("title")?.startsWith("Global"));
    fireEvent.doubleClick(screen.getAllByText("Setting")[0] as HTMLElement);
    await waitFor(() => expect(globalTab()).toBeTruthy());
    expect(iconBg(globalTab() as HTMLElement)).not.toContain("teal");
  });

  it("opens data as a form of its schema, filled in", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("Aria"));
    expect(
      ((await screen.findByLabelText(/^Nickname/)) as HTMLInputElement).value,
    ).toBe("Ari");
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      "Aria",
    );
  });

  it("opens an inherited schema in the tab of the scope it lives in", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(must(screen.getAllByText("Setting")[0]));
    await screen.findByLabelText(/^Name/);
    expect(screen.getByRole("tab").textContent).toContain("Setting · Global");
    expect(vi.mocked(api.getSchema)).toHaveBeenCalledWith(global, "sg");
  });

  it("remembers the open tabs for the page", async () => {
    const first = show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    fireEvent.doubleClick(await screen.findByText("Character"));
    await screen.findByLabelText(/^Name/);
    first.unmount();
    show(<StructuredExplorer page={session} projectId="p1" />);
    expect(await screen.findByRole("tab")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("tab").textContent).toContain("Character"),
    );
  });
});

describe("editing data", () => {
  beforeEach(mockApi);

  async function openAria() {
    fireEvent.click(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("Aria"));
    return (await screen.findByLabelText(/^Nickname/)) as HTMLInputElement;
  }

  it("saves a change made in the form: a dot on the tab, then Save writes the value", async () => {
    const save = vi
      .spyOn(api, "saveData")
      .mockResolvedValue({ ...dataDetail(ARIA) });
    show(<StructuredExplorer page={session} projectId="p1" />);
    const nick = await openAria();
    fireEvent.change(nick, { target: { value: "Ari the Bold" } });
    expect(
      await screen.findByRole("img", { name: "Unsaved changes" }),
    ).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(session, "d1", {
        name: "Aria",
        description: "Aria data",
        value: { nickname: "Ari the Bold", hp: 7 },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull(),
    );
  });

  it("shows the JSON of the value, and saves what was typed there", async () => {
    const save = vi
      .spyOn(api, "saveData")
      .mockResolvedValue({ ...dataDetail(ARIA) });
    show(<StructuredExplorer page={session} projectId="p1" />);
    await openAria();
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(JSON.parse(editorText())).toEqual({ nickname: "Ari", hp: 7 });
    typeInEditor('{"nickname":"Json","hp":1}');
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(session, "d1", {
        name: "Aria",
        description: "Aria data",
        value: { nickname: "Json", hp: 1 },
      }),
    );
  });

  it("carries JSON edits back into the form", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await openAria();
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor('{"nickname":"Edited","hp":2}');
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    expect(
      ((await screen.findByLabelText(/^Nickname/)) as HTMLInputElement).value,
    ).toBe("Edited");
  });

  it("stays in JSON, with the reason, when the JSON cannot be read", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await openAria();
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    typeInEditor("{not json");
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    expect(await screen.findByText(/The JSON can't be read/)).toBeTruthy();
    expect(document.querySelector(".cm-editor")).not.toBeNull();
  });

  it("does not save a form that is missing an answer, and marks the field", async () => {
    const save = vi.spyOn(api, "saveData");
    show(<StructuredExplorer page={session} projectId="p1" />);
    const nick = await openAria();
    fireEvent.change(nick, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Answer this question.")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the backend's problems next to the fields", async () => {
    vi.spyOn(api, "saveData").mockRejectedValue(
      new Error("It cannot be saved:\n- /hp: must be integer."),
    );
    show(<StructuredExplorer page={session} projectId="p1" />);
    const nick = await openAria();
    fireEvent.change(nick, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("must be integer.")).toBeTruthy();
  });

  it("asks before saving data in a higher scope, and saves on yes", async () => {
    const save = vi
      .spyOn(api, "saveData")
      .mockResolvedValue({ ...dataDetail(HARBOUR) });
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(must(screen.getAllByText("Setting").at(-1)));
    fireEvent.click(await screen.findByText("Harbour"));
    const nick = (await screen.findByLabelText(
      /^Nickname/,
    )) as HTMLInputElement;
    fireEvent.change(nick, { target: { value: "Port" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Save the Global data/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        global,
        "d3",
        expect.objectContaining({ value: { nickname: "Port" } }),
      ),
    );
  });

  it("migrates to the latest schema version from the toolbar", async () => {
    const outdated = data("d1", "Aria", "sc", "session", {
      outOfDate: true,
      latestVersion: 2,
    });
    DATA.session = [outdated, COVE, LOST];
    vi.spyOn(api, "getData").mockResolvedValue({
      ...dataDetail(outdated),
      schema: { ...CHARACTER, pinned: BODY, latest: BODY_V2 },
    } as DataDetail);
    const migrate = vi
      .spyOn(api, "migrateData")
      .mockResolvedValue({ ...dataDetail(outdated) });
    try {
      show(<StructuredExplorer page={session} projectId="p1" />);
      fireEvent.click(await screen.findByText("Character"));
      fireEvent.click(await screen.findByText("Aria"));
      fireEvent.click(
        await screen.findByRole("button", { name: "Migrate to v2" }),
      );
      expect(await screen.findByLabelText(/^Mood/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Migrate to v2" }));
      await waitFor(() =>
        expect(migrate).toHaveBeenCalledWith(session, "d1", {
          nickname: "Ari",
          hp: 7,
        }),
      );
    } finally {
      DATA.session = [ARIA, COVE, LOST];
    }
  });
});

describe("editing schemas", () => {
  beforeEach(mockApi);

  it("saves a change made in the JSON view as a body", async () => {
    const save = vi
      .spyOn(api, "saveSchema")
      .mockResolvedValue({ ...CHARACTER, version: 2 });
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    await screen.findByText("nickname");
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")).not.toBeNull(),
    );
    expect(JSON.parse(editorText())).toEqual(BODY);
    const next = { type: "object", properties: { x: { type: "string" } } };
    typeInEditor(JSON.stringify(next));
    expect(
      await screen.findByRole("img", { name: "Unsaved changes" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(session, "sc", {
        name: "Character",
        description: "Character schema",
        body: next,
      }),
    );
  });

  it("saves a change made in the form (the builder)", async () => {
    const save = vi.spyOn(api, "saveSchema").mockResolvedValue(CHARACTER);
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Person" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[2]).toMatchObject({ name: "Person" });
    expect(save.mock.calls[0]?.[2]?.body).toMatchObject({
      type: "object",
      properties: { nickname: { type: "string" }, hp: { type: "integer" } },
    });
  });

  it("asks before saving a schema in a higher scope, and does nothing when declined", async () => {
    const save = vi.spyOn(api, "saveSchema").mockResolvedValue(SETTING);
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(must(screen.getAllByText("Setting")[0]));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Scenery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Save the Global schema/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("does not ask for a schema of the page's own scope", async () => {
    const save = vi.spyOn(api, "saveSchema").mockResolvedValue(SETTING);
    show(<StructuredExplorer page={global} />);
    fireEvent.click(await screen.findByText("Setting"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Scenery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cannot change a built-in schema", async () => {
    show(<StructuredExplorer page={global} />);
    fireEvent.click(await screen.findByText("Note"));
    await screen.findByText(/Built in: copy it to change it/);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("can be reverted", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Person" } });
    fireEvent.click(await screen.findByRole("button", { name: "Revert" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
        "Character",
      ),
    );
    expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
  });

  it("asks before closing a tab with unsaved changes", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Person" } });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Close Character · Session",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("tab")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Close Character · Session" }),
    );
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("tab")).toBeNull());
  });

  it("reports whether there are unsaved changes", async () => {
    const onDirtyChange = vi.fn();
    show(
      <StructuredExplorer
        page={session}
        projectId="p1"
        onDirtyChange={onDirtyChange}
      />,
    );
    fireEvent.click(await screen.findByText("Character"));
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(name, { target: { value: "Person" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });
});

describe("making things in the tree", () => {
  beforeEach(mockApi);

  it("makes a schema from an inline name: a tab to fill in, then Create", async () => {
    const create = vi
      .spyOn(api, "createSchema")
      .mockResolvedValue(schema("sn", "Monster", "session"));
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(screen.getByRole("button", { name: "New schema" }));
    const box = await screen.findByLabelText("New schema name");
    fireEvent.change(box, { target: { value: "Monster" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(create).not.toHaveBeenCalled();
    const name = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    expect(name.value).toBe("Monster");
    expect(screen.getByRole("tab").textContent).toContain("Monster · Session");
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "Things that bite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(session, {
        name: "Monster",
        description: "Things that bite",
        body: { type: "object", properties: {} },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Create" })).toBeNull(),
    );
  });

  it("will not create a schema without a description", async () => {
    const create = vi.spyOn(api, "createSchema");
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.click(screen.getByRole("button", { name: "New schema" }));
    const box = await screen.findByLabelText("New schema name");
    fireEvent.change(box, { target: { value: "Monster" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    expect(
      await screen.findByText(/Give a name and a description/),
    ).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("makes data under a schema from the right-click menu, in that root", async () => {
    const create = vi
      .spyOn(api, "createData")
      .mockResolvedValue({ ...dataDetail(ARIA), id: "d9", name: "Bram" });
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.contextMenu(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("New data here"));
    const box = await screen.findByLabelText("New data name");
    fireEvent.change(box, { target: { value: "Bram" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const nick = (await screen.findByLabelText(
      /^Nickname/,
    )) as HTMLInputElement;
    fireEvent.change(nick, { target: { value: "Bram the Brave" } });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "A friend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(session, "sc", {
        name: "Bram",
        description: "A friend",
        value: { nickname: "Bram the Brave" },
      }),
    );
  });

  it("makes data of an inherited schema in the root it is shown under", async () => {
    const create = vi
      .spyOn(api, "createData")
      .mockResolvedValue({ ...dataDetail(COVE), id: "d9" });
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.contextMenu(must(screen.getAllByText("Setting")[0]));
    fireEvent.click(await screen.findByText("New data here"));
    const box = await screen.findByLabelText("New data name");
    fireEvent.change(box, { target: { value: "Dock" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(await screen.findByLabelText(/^Nickname/), {
      target: { value: "The Dock" },
    });
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: "Where ships tie up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(session, "sg", expect.anything()),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers New data only when a schema is picked", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    const button = () =>
      screen.getByRole("button", { name: "New data" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByText("Character"));
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("deletes a schema from the right-click menu, after asking", async () => {
    const remove = vi.spyOn(api, "deleteSchema").mockResolvedValue({ data: 2 });
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.contextMenu(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("Delete schema"));
    const dialog = await screen.findByRole("dialog");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(session, "sc"));
  });

  it("does not offer to delete an inherited schema", async () => {
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    fireEvent.contextMenu(must(screen.getAllByText("Setting")[0]));
    expect(await screen.findByText("New data here")).toBeTruthy();
    expect(screen.queryByText("Delete schema")).toBeNull();
  });

  it("deletes data from its tab, after asking", async () => {
    const remove = vi.spyOn(api, "deleteData").mockResolvedValue({});
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("Aria"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith(session, "d1"));
  });

  it("copies a schema to another scope from the right-click menu", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listAgents").mockResolvedValue([]);
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.contextMenu(await screen.findByText("Character"));
    fireEvent.click(await screen.findByText("Copy to…"));
    expect(await screen.findByText("Copy Character")).toBeTruthy();
  });
});

describe("read-only", () => {
  beforeEach(mockApi);

  it("cannot be changed in any root while a run is in progress", async () => {
    const save = vi.spyOn(api, "saveSchema");
    show(
      <StructuredExplorer
        page={session}
        projectId="p1"
        readOnly="A run is in progress."
      />,
    );
    await screen.findByText("Character");
    for (const name of ["New schema", "New data"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    fireEvent.click(must(screen.getAllByText("Setting").at(-1)));
    expect(await screen.findByText("A run is in progress.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByText("Session"));
    expect(
      await screen.findByText("This cannot be changed right now."),
    ).toBeTruthy();
  });

  it("locks only the project root when the project is in the trash", async () => {
    show(
      <StructuredExplorer
        page={session}
        projectId="p1"
        projectReadOnly="The project is in the trash."
      />,
    );
    fireEvent.click(must((await screen.findAllByText("Place")).at(-1)));
    expect(
      await screen.findByText("The project is in the trash."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByText("Character"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeTruthy(),
    );
  });

  it("shows data with no schema as JSON only", async () => {
    vi.spyOn(api, "getData").mockResolvedValue({
      ...dataDetail(LOST),
      value: { raw: 1 },
    } as DataDetail);
    show(<StructuredExplorer page={session} projectId="p1" />);
    fireEvent.click(await screen.findByText("Unknown schema"));
    fireEvent.click(await screen.findByText("Lost"));
    expect(
      await screen.findByText(/Its schema is not available here/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "JSON" })).toBeNull();
  });
});

describe("the divider", () => {
  beforeEach(mockApi);

  it("resizes the tree with the arrow keys, within limits, and remembers it", async () => {
    const first = show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    const bar = screen.getByRole("separator");
    expect(bar.getAttribute("aria-valuenow")).toBe("280");
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("aria-valuenow")).toBe("296");
    for (let i = 0; i < 30; i++) fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(bar.getAttribute("aria-valuenow")).toBe("520");
    first.unmount();
    show(<StructuredExplorer page={session} projectId="p1" />);
    await screen.findByText("Character");
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(
      "520",
    );
  });
});

describe("over an agent's root", () => {
  const AGENT: DataOwner = { scope: "agent", id: "a1" };
  const agentRoot = (extra: Partial<StructuredRoot> = {}): StructuredRoot[] => [
    { id: "agent", label: "Agent", scope: AGENT, ...extra },
  ];
  const OWN_AGENT = schema("sa", "Clue", "agent");
  const NOTES = data("d9", "Case notes", "sa", "agent");

  beforeEach(() => {
    mockApi();
    vi.spyOn(api, "dataSchemas").mockResolvedValue([
      OWN_AGENT,
      PLACE,
      SETTING,
      BUILTIN,
    ]);
    vi.spyOn(api, "listSchemas").mockResolvedValue({
      readOnly: null,
      schemas: [OWN_AGENT],
    });
    vi.spyOn(api, "listData").mockResolvedValue({
      readOnly: null,
      data: [NOTES],
    });
    vi.spyOn(api, "getSchema").mockResolvedValue(schemaDetail(OWN_AGENT));
    vi.spyOn(api, "getData").mockResolvedValue({
      ...dataDetail(NOTES),
      value: { nickname: "Ari" },
      schema: { ...OWN_AGENT, pinned: BODY, latest: BODY },
    } as DataDetail);
  });

  it("shows one root with the agent's schemas and data, and the others' schemas as inherited", async () => {
    show(
      <StructuredRoots
        roots={agentRoot()}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    expect(await screen.findByText("Agent")).toBeTruthy();
    expect(screen.getAllByText("Schemas")).toHaveLength(1);
    expect(await screen.findByText("Clue")).toBeTruthy();
    for (const name of ["Place", "Setting", "Note"])
      expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getAllByTestId("inherited-schema")).toHaveLength(3);
    expect(vi.mocked(api.listSchemas)).toHaveBeenCalledWith(AGENT, false);
    expect(vi.mocked(api.listData)).toHaveBeenCalledWith(AGENT, false);
  });

  it("opens the agent's own schema for editing, through the agent", async () => {
    show(
      <StructuredRoots
        roots={agentRoot()}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    fireEvent.click(await screen.findByText("Clue"));
    await screen.findByLabelText(/^Name/);
    expect(vi.mocked(api.getSchema)).toHaveBeenCalledWith(AGENT, "sa");
    expect(screen.getByRole("tab").textContent).toContain("Clue · Agent");
    expect(screen.queryByText("Read-only")).toBeNull();
  });

  it("opens an inherited schema read-only, in the root it was opened from", async () => {
    show(
      <StructuredRoots
        roots={agentRoot()}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    fireEvent.click(await screen.findByText("Place"));
    await screen.findByLabelText(/^Name/);
    expect(vi.mocked(api.schemaBody)).toHaveBeenCalledWith(AGENT, "sp");
    expect(vi.mocked(api.getSchema)).not.toHaveBeenCalled();
    expect(screen.getByRole("tab").textContent).toContain("Place · Agent");
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("makes and changes data through the agent", async () => {
    show(
      <StructuredRoots
        roots={agentRoot()}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    fireEvent.click(await screen.findByText("Clue"));
    fireEvent.click(await screen.findByText("Case notes"));
    await screen.findByLabelText(/^Nickname/);
    expect(vi.mocked(api.getData)).toHaveBeenCalledWith(AGENT, "d9");
    expect(screen.queryByText("Read-only")).toBeNull();
  });

  it("is read-only, all of it, when the caller says why", async () => {
    show(
      <StructuredRoots
        roots={agentRoot({ readOnly: "The agent is deleted." })}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    fireEvent.click(await screen.findByText("Clue"));
    await screen.findByLabelText(/^Name/);
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("remembers its tabs under the key it is given", async () => {
    show(
      <StructuredRoots
        roots={agentRoot()}
        viewKey="agent.a1"
        pageRoot="agent"
      />,
    );
    fireEvent.click(await screen.findByText("Clue"));
    await screen.findByLabelText(/^Name/);
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("harness.structured.agent.a1") ?? "{}")
          .tabs,
      ).toEqual([
        { kind: "schema", root: "agent", key: "sa", transient: true },
      ]),
    );
  });
});
