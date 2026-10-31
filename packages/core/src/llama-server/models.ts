/*
 * Lists the models llama-server can serve.
 *
 * - Router mode: GET /models lists every model the router knows, with its
 *   status (loaded, unloaded, loading, sleeping, ...).
 * - A single-model server has no /models route; GET /v1/models lists the one
 *   loaded model.
 *
 * Shapes follow llama.cpp's server README (master).
 */

export interface ModelInfo {
  id: string;
  /** Router mode only, for example "loaded" or "unloaded". */
  status?: string;
}

interface ModelList {
  data?: { id?: unknown; status?: { value?: unknown } }[];
}

export async function listLlamaServerModels(
  baseUrl: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ModelInfo[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = baseUrl.replace(/\/+$/, "");
  const get = (path: string) =>
    doFetch(base + path, options.signal ? { signal: options.signal } : {});

  let res = await get("/models");
  if (res.status === 404) res = await get("/v1/models");
  if (!res.ok) {
    throw new Error(
      `llama-server ${new URL(res.url).pathname} returned ${res.status}`,
    );
  }
  const body = (await res.json()) as ModelList;
  return (body.data ?? [])
    .filter(
      (m): m is { id: string; status?: { value?: unknown } } =>
        typeof m.id === "string",
    )
    .map((m) =>
      typeof m.status?.value === "string"
        ? { id: m.id, status: m.status.value }
        : { id: m.id },
    );
}
