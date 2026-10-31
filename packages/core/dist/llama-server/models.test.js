import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeLlamaServer } from "./fake-llama-server.js";
import { listLlamaServerModels } from "./models.js";
let server;
let url;
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
        await expect(listLlamaServerModels(url)).rejects.toThrow("llama-server /v1/models returned 404");
    });
});
//# sourceMappingURL=models.test.js.map