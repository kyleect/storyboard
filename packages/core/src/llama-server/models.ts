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
  /** Router mode only, for example "loaded", "loading" or "unloaded". */
  status?: string;
  /** Router mode only: the last load attempt failed. */
  failed?: boolean;
}

interface ListedModel {
  id: string;
  status?: { value?: unknown; failed?: unknown };
}

interface ModelList {
  data?: { id?: unknown; status?: ListedModel["status"] }[];
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
    .filter((m): m is ListedModel => typeof m.id === "string")
    .map((m) => ({
      id: m.id,
      ...(typeof m.status?.value === "string"
        ? { status: m.status.value }
        : {}),
      ...(m.status?.failed === true ? { failed: true } : {}),
    }));
}

/** The outcome of asking the router to load a model. */
export type LoadResult =
  { ok: true; alreadyRunning: boolean } | { ok: false; message: string };

/**
 * Asks a router to load a model: POST /models/load. The router starts the
 * load and answers right away; GET /models then shows "loading" and later
 * "loaded" (tools/server/server-models.cpp, master). A model that is
 * loading, loaded or asleep counts as already running. A single-model
 * server has no such route; that is reported as not ok.
 */
export async function loadLlamaServerModel(
  baseUrl: string,
  model: string,
  options: { fetch?: typeof fetch } = {},
): Promise<LoadResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/models/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (res.ok) return { ok: true, alreadyRunning: false };
  const message =
    body.error?.message ?? `llama-server /models/load returned ${res.status}`;
  if (res.status === 400 && /already running/.test(message)) {
    return { ok: true, alreadyRunning: true };
  }
  if (res.status >= 400 && res.status < 500) return { ok: false, message };
  throw new Error(message);
}
