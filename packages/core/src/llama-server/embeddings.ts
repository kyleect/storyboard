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

  /**
   * @param status The HTTP status of llama-server's answer; undefined when no
   * answer arrived (it could not be reached) or its body was unusable.
   * @param type The `error.type` of the answer's body, for example
   * "exceed_context_size_error".
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly type?: string,
  ) {
    super(message);
  }
}

interface EmbeddingsBody {
  data?: { embedding?: unknown; index?: unknown }[];
  error?: { message?: string; type?: string };
}

/*
 * llama-server refuses an embedding input that does not fit (tools/server/
 * server-context.cpp, master 1719dbb): above the physical batch size it
 * answers 500 "input (N tokens) is too large to process. increase the
 * physical batch size (current batch size: M)"; above the slot's context it
 * answers 400, type "exceed_context_size_error", "input (N tokens) is larger
 * than the max context size (X tokens). skipping". One input that does not
 * fit fails the whole request.
 */
const OVERSIZE_MESSAGE =
  /too large to process|larger than the max context size|exceeds the available context size/i;

/** Whether llama-server refused an input for its size (see above). */
export function isOversizeError(err: unknown): boolean {
  return (
    err instanceof EmbeddingError &&
    err.status !== undefined &&
    (err.type === "exceed_context_size_error" ||
      OVERSIZE_MESSAGE.test(err.message))
  );
}

/** Whether llama-server answered with an error (it was reached). */
export function isResponseError(err: unknown): err is EmbeddingError {
  return err instanceof EmbeddingError && err.status !== undefined;
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
      res.status,
      body.error?.type,
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
