import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmbeddingError,
  embedTexts,
  isOversizeError,
  isResponseError,
} from "./embeddings.js";
import { FakeLlamaServer, FakeServerError } from "./fake-llama-server.js";

let server: FakeLlamaServer;
let url: string;

beforeEach(async () => {
  server = new FakeLlamaServer();
  url = await server.start();
});
afterEach(() => server.stop());

describe("embedTexts", () => {
  it("posts the model and inputs and returns vectors in input order", async () => {
    server.onEmbeddings((inputs) => inputs.map((t) => [t.length, 1]));
    expect(await embedTexts(url + "/", "embed-m", ["a", "bbb"])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/embeddings",
      body: { model: "embed-m", input: ["a", "bbb"] },
    });
  });

  it("orders vectors by their index", async () => {
    server.reply({
      json: {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      },
    });
    expect(await embedTexts(url, "m", ["x", "y"])).toEqual([[1], [2]]);
  });

  it("throws llama-server's message on an error", async () => {
    server.onEmbeddings(() => new Error("model is not an embedding model"));
    await expect(embedTexts(url, "m", ["x"])).rejects.toThrow(
      new EmbeddingError("model is not an embedding model", 400),
    );
  });

  it("throws when a vector is missing or malformed", async () => {
    server.reply({ json: { data: [{ index: 0, embedding: [1] }] } });
    await expect(embedTexts(url, "m", ["x", "y"])).rejects.toThrow(
      /no embedding for input 1/,
    );
    server.reply({ json: { data: [{ index: 0, embedding: ["a"] }] } });
    await expect(embedTexts(url, "m", ["x"])).rejects.toThrow(/not a list/);
  });

  it("sends nothing for no inputs", async () => {
    expect(await embedTexts(url, "m", [])).toEqual([]);
    expect(server.requests).toHaveLength(0);
  });
});

describe("embedding errors", () => {
  it("carries the status and the error type of llama-server's answer", async () => {
    server.onEmbeddings(
      () =>
        new FakeServerError(
          "input (1090 tokens) is too large to process. increase the physical batch size (current batch size: 1024)",
          500,
          "server_error",
        ),
    );
    const err = await embedTexts(url, "m", ["x"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).toMatchObject({ status: 500, type: "server_error" });
    expect(isResponseError(err)).toBe(true);
    expect(isOversizeError(err)).toBe(true);
  });

  it("has no status when the server cannot be reached", async () => {
    await server.stop();
    const err = await embedTexts(url, "m", ["x"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).status).toBeUndefined();
    expect(isResponseError(err)).toBe(false);
    expect(isOversizeError(err)).toBe(false);
    // afterEach stops the server again.
    server = new FakeLlamaServer();
    url = await server.start();
  });

  it.each([
    [
      "the batch size",
      new EmbeddingError(
        "input (2199 tokens) is too large to process. increase the physical batch size (current batch size: 512)",
        500,
        "server_error",
      ),
      true,
    ],
    [
      "the context size, by type",
      new EmbeddingError("whatever it says", 400, "exceed_context_size_error"),
      true,
    ],
    [
      "the context size, by message",
      new EmbeddingError(
        "input (900 tokens) is larger than the max context size (512 tokens). skipping",
        500,
      ),
      true,
    ],
    [
      "an unrelated server error",
      new EmbeddingError("failed to get embeddings", 500, "server_error"),
      false,
    ],
    [
      "a size message with no answer from the server",
      new EmbeddingError("input is too large to process"),
      false,
    ],
    ["an error that is not an EmbeddingError", new Error("too large"), false],
  ])("tells %s from other failures: %s", (_, err, oversize) => {
    expect(isOversizeError(err)).toBe(oversize);
  });
});
