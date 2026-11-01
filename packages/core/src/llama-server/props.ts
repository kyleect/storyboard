/*
 * Reads model properties from llama-server's GET /props.
 *
 * `chat_template_caps.reasoning_effort_levels` lists the `reasoning_effort`
 * values the model's chat template renders distinctly, lowest to highest
 * (llama.cpp server README and common/chat.cpp, master).
 *
 * `default_generation_settings.n_ctx` is the context size of one slot: the
 * server's context size divided among its parallel slots
 * (tools/server/server-context.cpp, get_res_props). Without `?model=`, a
 * router answers with a placeholder `n_ctx` of 0
 * (tools/server/server-models.cpp).
 *
 * In router mode the model is chosen with `?model=`, and `autoload=false`
 * keeps this from loading a model just to read its properties: the router
 * answers "model is not loaded" instead (tools/server/server-models.cpp).
 */

interface PropsOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

interface PropsBody {
  error?: { message?: string };
  chat_template_caps?: { reasoning_effort_levels?: unknown };
  default_generation_settings?: { n_ctx?: unknown };
}

/**
 * The /props body, or `unavailable` with llama-server's reason when it
 * declines (a 4xx answer). Throws when llama-server cannot be reached or
 * fails.
 */
async function getProps(
  baseUrl: string,
  model: string | undefined,
  options: PropsOptions,
): Promise<{ body: PropsBody } | { unavailable: string }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const query = new URLSearchParams({ autoload: "false" });
  if (model) query.set("model", model);
  const res = await doFetch(
    `${baseUrl.replace(/\/+$/, "")}/props?${query.toString()}`,
    options.signal ? { signal: options.signal } : {},
  );
  const body = (await res.json().catch(() => ({}))) as PropsBody;
  const message =
    body.error?.message ?? `llama-server /props returned ${res.status}`;
  if (res.status >= 400 && res.status < 500) return { unavailable: message };
  if (!res.ok) throw new Error(message);
  return { body };
}

/**
 * `levels` when llama-server can say; `unavailable` with its reason when it
 * declines (for example "model is not loaded"). Throws when llama-server
 * cannot be reached or fails.
 */
export type ReasoningLevels = { levels: string[] } | { unavailable: string };

export async function getReasoningLevels(
  baseUrl: string,
  model: string | undefined,
  options: PropsOptions = {},
): Promise<ReasoningLevels> {
  const props = await getProps(baseUrl, model, options);
  if ("unavailable" in props) return props;
  const levels = props.body.chat_template_caps?.reasoning_effort_levels;
  return {
    levels: Array.isArray(levels)
      ? levels.filter((l): l is string => typeof l === "string")
      : [],
  };
}

/**
 * `contextSize` in tokens when llama-server reports one; `unavailable` with
 * the reason when it declines (for example "model is not loaded") or reports
 * none (a missing value, or a router's placeholder 0). Throws when
 * llama-server cannot be reached or fails.
 */
export type ContextSize = { contextSize: number } | { unavailable: string };

export const NO_CONTEXT_SIZE = "llama-server did not report a context size.";

export async function getContextSize(
  baseUrl: string,
  model: string | undefined,
  options: PropsOptions = {},
): Promise<ContextSize> {
  const props = await getProps(baseUrl, model, options);
  if ("unavailable" in props) return props;
  const n = props.body.default_generation_settings?.n_ctx;
  return typeof n === "number" && Number.isInteger(n) && n > 0
    ? { contextSize: n }
    : { unavailable: NO_CONTEXT_SIZE };
}
