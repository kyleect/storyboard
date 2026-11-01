import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLlamaServer } from "./fake-llama-server.js";
import {
  getContextSize,
  getReasoningLevels,
  NO_CONTEXT_SIZE,
} from "./props.js";

let server: FakeLlamaServer;
let url: string;
beforeEach(async () => {
  server = new FakeLlamaServer();
  url = await server.start();
});
afterEach(() => server.stop());

describe("getReasoningLevels", () => {
  it("reads the template's levels for a model without loading it", async () => {
    server.onGet("/props", {
      chat_template_caps: {
        supports_reasoning_effort: true,
        reasoning_effort_levels: ["low", "medium", "high"],
      },
    });
    expect(await getReasoningLevels(url, "qwen 3/x")).toEqual({
      levels: ["low", "medium", "high"],
    });
    expect(server.requests[0]?.path).toBe(
      "/props?autoload=false&model=qwen+3%2Fx",
    );
  });

  it("returns no levels when the template lists none", async () => {
    server.onGet("/props", { chat_template_caps: {} });
    expect(await getReasoningLevels(url, undefined)).toEqual({ levels: [] });
    expect(server.requests[0]?.path).toBe("/props?autoload=false");
  });

  it("reports the router declining for a model that is not loaded", async () => {
    server.onGet(
      "/props",
      {
        error: {
          code: 400,
          message: "model is not loaded",
          type: "invalid_request_error",
        },
      },
      400,
    );
    expect(await getReasoningLevels(url, "gemma")).toEqual({
      unavailable: "model is not loaded",
    });
  });

  it("throws when llama-server fails", async () => {
    server.onGet("/props", { error: { message: "boom" } }, 500);
    await expect(getReasoningLevels(url, "gemma")).rejects.toThrow("boom");
  });
});

describe("getContextSize", () => {
  it("reads one slot's context size for a model without loading it", async () => {
    server.onGet("/props", {
      default_generation_settings: { params: {}, n_ctx: 32768 },
      total_slots: 4,
    });
    expect(await getContextSize(url, "qwen 3/x")).toEqual({
      contextSize: 32768,
    });
    expect(server.requests[0]?.path).toBe(
      "/props?autoload=false&model=qwen+3%2Fx",
    );
  });

  it("treats a router's placeholder 0 as no size", async () => {
    server.onGet("/props", {
      role: "router",
      default_generation_settings: { params: {}, n_ctx: 0 },
    });
    expect(await getContextSize(url, undefined)).toEqual({
      unavailable: NO_CONTEXT_SIZE,
    });
    expect(server.requests[0]?.path).toBe("/props?autoload=false");
  });

  it("reports no size when the server leaves it out", async () => {
    server.onGet("/props", {});
    expect(await getContextSize(url, "gemma")).toEqual({
      unavailable: NO_CONTEXT_SIZE,
    });
  });

  it("reports the router declining for a model that is not loaded", async () => {
    server.onGet(
      "/props",
      { error: { code: 400, message: "model is not loaded" } },
      400,
    );
    expect(await getContextSize(url, "gemma")).toEqual({
      unavailable: "model is not loaded",
    });
  });

  it("throws when llama-server fails", async () => {
    server.onGet("/props", { error: { message: "boom" } }, 500);
    await expect(getContextSize(url, "gemma")).rejects.toThrow("boom");
  });
});
