import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { filesSource } from "./explorer-source";
import { fileKeys } from "../queries";

describe("filesSource", () => {
  afterEach(() => vi.restoreAllMocks());

  const scope = { scope: "project", id: "p1" } as const;

  it("names its query keys with the files key factory", () => {
    const s = filesSource(scope);
    expect(s.keys.all).toEqual(fileKeys.inScope(scope));
    expect(s.keys.list(true)).toEqual(fileKeys.list(scope, true));
    expect(s.keys.folders()).toEqual(fileKeys.folders(scope));
    expect(s.keys.detail("a.md")).toEqual(fileKeys.detail(scope, "a.md"));
  });

  it("passes every call to the files API with its scope", async () => {
    const list = vi.spyOn(api, "listFiles").mockResolvedValue([]);
    const write = vi.spyOn(api, "writeFile").mockResolvedValue({} as never);
    const rename = vi
      .spyOn(api, "renameFolder")
      .mockResolvedValue(undefined as never);
    const upload = vi
      .spyOn(api, "uploadFile")
      .mockResolvedValue({ key: "d/x.png" } as never);
    const s = filesSource(scope);
    await s.list(false);
    await s.write("a.md", "text/markdown", "hi");
    await s.renameFolder("d", "e");
    const file = new File(["x"], "x.png");
    expect(await s.upload(file, "image/png", "d/x.png")).toEqual({
      key: "d/x.png",
    });
    expect(list).toHaveBeenCalledWith(scope, false);
    expect(write).toHaveBeenCalledWith(scope, "a.md", "text/markdown", "hi");
    expect(rename).toHaveBeenCalledWith(scope, "d", "e");
    expect(upload).toHaveBeenCalledWith(scope, file, "image/png", {
      name: "d/x.png",
    });
  });
});
