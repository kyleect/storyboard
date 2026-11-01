import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingError, embedTexts } from "./embeddings.js";
import { FakeLlamaServer } from "./fake-llama-server.js";

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
      new EmbeddingError("model is not an embedding model"),
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
