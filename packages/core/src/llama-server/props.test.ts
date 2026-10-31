import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLlamaServer } from "./fake-llama-server.js";
import { getReasoningLevels } from "./props.js";

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
    expect(await getReasoningLevels(url, "qwen 3/x")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(server.requests[0]?.path).toBe(
      "/props?autoload=false&model=qwen+3%2Fx",
    );
  });

  it("returns no levels when the template lists none", async () => {
    server.onGet("/props", { chat_template_caps: {} });
    expect(await getReasoningLevels(url, undefined)).toEqual([]);
    expect(server.requests[0]?.path).toBe("/props?autoload=false");
  });

  it("passes on the router's error for a model that is not loaded", async () => {
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
    await expect(getReasoningLevels(url, "gemma")).rejects.toThrow(
      "model is not loaded",
    );
  });
});
