import { describe, expect, it } from "vitest";
import { modelMediaSupport } from "./media-support.js";

const models = [
  { id: "gemma", inputModalities: ["text", "image", "audio"] },
  { id: "plain", inputModalities: ["text"] },
  { id: "old" },
];

describe("modelMediaSupport", () => {
  it("reads support from the model's input modalities", async () => {
    const support = modelMediaSupport(() => "http://x", {
      list: () => Promise.resolve(models),
    });
    expect(await support("gemma")).toEqual({ image: true, audio: true });
    expect(await support("plain")).toEqual({ image: false, audio: false });
  });

  it("is undefined when the server does not say or the model is unknown", async () => {
    const support = modelMediaSupport(() => "http://x", {
      list: () => Promise.resolve(models),
    });
    expect(await support("old")).toBeUndefined();
    expect(await support("nope")).toBeUndefined();
    // No name and several models: not known.
    expect(await support(null)).toBeUndefined();
  });

  it("uses the only model of a single-model server when none is named", async () => {
    const support = modelMediaSupport(() => "http://x", {
      list: () => Promise.resolve([models[0] as (typeof models)[0]]),
    });
    expect(await support(null)).toEqual({ image: true, audio: true });
  });

  it("asks again after the cache expires or the URL changes", async () => {
    let calls = 0;
    let t = 0;
    let url = "http://a";
    const support = modelMediaSupport(() => url, {
      list: () => {
        calls++;
        return Promise.resolve(models);
      },
      now: () => t,
    });
    await support("gemma");
    await support("gemma");
    expect(calls).toBe(1);
    t = 31_000;
    await support("gemma");
    expect(calls).toBe(2);
    url = "http://b";
    await support("gemma");
    expect(calls).toBe(3);
  });
});
