import {
  listLlamaServerModels,
  mediaSupport,
  type MediaSupport,
  type ModelInfo,
} from "@harness/core";

/*
 * Whether the model in use reads images and audio, from the server's model
 * list (`input_modalities`). The list is cached briefly: it is asked for at
 * the start of every run.
 */

const TTL_MS = 30_000;

export function modelMediaSupport(
  baseUrl: () => string,
  options: {
    list?: (baseUrl: string) => Promise<ModelInfo[]>;
    now?: () => number;
  } = {},
): (model: string | null) => Promise<MediaSupport | undefined> {
  const list = options.list ?? ((url) => listLlamaServerModels(url));
  const now = options.now ?? Date.now;
  let cached: { url: string; at: number; models: ModelInfo[] } | undefined;
  return async (model) => {
    const url = baseUrl();
    if (!cached || cached.url !== url || now() - cached.at > TTL_MS) {
      cached = { url, at: now(), models: await list(url) };
    }
    // A single-model server needs no name.
    const info = model
      ? cached.models.find((m) => m.id === model)
      : cached.models.length === 1
        ? cached.models[0]
        : undefined;
    return mediaSupport(info);
  };
}
