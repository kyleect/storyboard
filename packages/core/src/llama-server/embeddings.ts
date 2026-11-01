/*
 * Embeddings from llama-server's OpenAI-compatible POST /v1/embeddings
 * (tools/server/README.md, master 060b2fe): `input` is a string or a list
 * of strings; each `data[i].embedding` is a Euclidean-normalized vector,
 * with `data[i].index` naming its input. In router mode `model` picks the
 * embedding model, and the router loads it if needed (plan S8). The model
 * must be a dedicated embedding model; llama-server needs `--embeddings`
 * for it, for example in a router preset.
 */

export interface EmbedOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class EmbeddingError extends Error {
  override name = "EmbeddingError";
}

interface EmbeddingsBody {
  data?: { embedding?: unknown; index?: unknown }[];
  error?: { message?: string };
}

/** One vector per input, in input order. Throws EmbeddingError on failure. */
export async function embedTexts(
  baseUrl: string,
  model: string,
  inputs: readonly string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: inputs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new EmbeddingError(
      `Could not reach llama-server: ${(err as Error).message}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as EmbeddingsBody;
  if (!res.ok) {
    throw new EmbeddingError(
      body.error?.message ??
        `llama-server /v1/embeddings returned ${res.status}`,
    );
  }
  const out: number[][] = new Array<number[]>(inputs.length);
  for (const [i, item] of (body.data ?? []).entries()) {
    const index = typeof item.index === "number" ? item.index : i;
    const v = item.embedding;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "number")) {
      throw new EmbeddingError(
        "llama-server sent an embedding that is not a list of numbers.",
      );
    }
    out[index] = v as number[];
  }
  for (let i = 0; i < inputs.length; i++) {
    if (!out[i]) {
      throw new EmbeddingError(
        `llama-server sent no embedding for input ${i}.`,
      );
    }
  }
  return out;
}
