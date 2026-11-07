import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLlamaServer } from "./fake-llama-server.js";
import {
  listLlamaServerModels,
  loadLlamaServerModel,
  mediaSupport,
} from "./models.js";

let server: FakeLlamaServer;
let url: string;
beforeEach(async () => {
  server = new FakeLlamaServer();
  url = await server.start();
});
afterEach(() => server.stop());

describe("listLlamaServerModels", () => {
  it("lists the router's models with their status", async () => {
    server.onGet("/models", {
      data: [
        {
          id: "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M",
          path: "/x.gguf",
          status: { value: "loaded", args: ["llama-server"] },
        },
        { id: "qwen3-8b", status: { value: "unloaded" } },
      ],
    });
    expect(await listLlamaServerModels(url)).toEqual([
      { id: "ggml-org/gemma-3-4b-it-GGUF:Q4_K_M", status: "loaded" },
      { id: "qwen3-8b", status: "unloaded" },
    ]);
  });

  it("reads what each model can read from architecture.input_modalities", async () => {
    server.onGet("/models", {
      data: [
        {
          id: "gemma-4-E4B-it",
          status: { value: "unloaded" },
          architecture: { input_modalities: ["text", "image", "audio", 7] },
        },
        { id: "qwen3-8b", architecture: { input_modalities: ["text"] } },
        { id: "old", architecture: {} },
      ],
    });
    expect(await listLlamaServerModels(url)).toEqual([
      {
        id: "gemma-4-E4B-it",
        status: "unloaded",
        inputModalities: ["text", "image", "audio"],
      },
      { id: "qwen3-8b", inputModalities: ["text"] },
      { id: "old" },
    ]);
  });

  it("falls back to /v1/models on a single-model server", async () => {
    server.onGet("/v1/models", {
      object: "list",
      data: [{ id: "my-model.gguf", object: "model", meta: null }],
    });
    expect(await listLlamaServerModels(url + "/")).toEqual([
      { id: "my-model.gguf" },
    ]);
    expect(server.requests.map((r) => r.path)).toEqual([
      "/models",
      "/v1/models",
    ]);
  });

  it("throws when neither route answers", async () => {
    await expect(listLlamaServerModels(url)).rejects.toThrow(
      "llama-server /v1/models returned 404",
    );
  });
});

describe("failed loads", () => {
  it("reports a model whose last load failed", async () => {
    server.onGet("/models", {
      data: [
        {
          id: "big",
          status: { value: "unloaded", failed: true, exit_code: 1 },
        },
      ],
    });
    expect(await listLlamaServerModels(url)).toEqual([
      { id: "big", status: "unloaded", failed: true },
    ]);
  });
});

describe("loadLlamaServerModel", () => {
  it("asks the router to load a model", async () => {
    server.reply({ json: { success: true } });
    expect(await loadLlamaServerModel(url + "/", "qwen")).toEqual({
      ok: true,
      alreadyRunning: false,
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/models/load",
      body: { model: "qwen" },
    });
  });

  it("treats an already running model as loaded", async () => {
    server.reply({
      status: 400,
      errorBody: {
        error: {
          code: 400,
          message: "model is already running",
          type: "invalid_request_error",
        },
      },
    });
    expect(await loadLlamaServerModel(url, "qwen")).toEqual({
      ok: true,
      alreadyRunning: true,
    });
  });

  it("reports an unknown model, or a server without the route", async () => {
    server.reply(
      {
        status: 404,
        errorBody: {
          error: {
            code: 404,
            message: "model is not found",
            type: "not_found_error",
          },
        },
      },
      { status: 404, errorBody: {} },
    );
    expect(await loadLlamaServerModel(url, "nope")).toEqual({
      ok: false,
      message: "model is not found",
    });
    expect(await loadLlamaServerModel(url, "x")).toEqual({
      ok: false,
      message: "llama-server /models/load returned 404",
    });
  });

  it("throws when llama-server fails", async () => {
    server.reply({ status: 500, errorBody: { error: { message: "boom" } } });
    await expect(loadLlamaServerModel(url, "qwen")).rejects.toThrow("boom");
  });
});

describe("mediaSupport", () => {
  it("says what a model reads, or nothing when the server did not say", () => {
    expect(
      mediaSupport({ inputModalities: ["text", "image", "audio"] }),
    ).toEqual({ image: true, audio: true });
    expect(mediaSupport({ inputModalities: ["text", "image"] })).toEqual({
      image: true,
      audio: false,
    });
    expect(mediaSupport({ inputModalities: ["text"] })).toEqual({
      image: false,
      audio: false,
    });
    expect(mediaSupport({})).toBeUndefined();
    expect(mediaSupport(undefined)).toBeUndefined();
  });
});
