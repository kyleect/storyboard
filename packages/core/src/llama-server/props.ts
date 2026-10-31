/*
 * Reads a model's reasoning effort levels from llama-server's GET /props.
 *
 * `chat_template_caps.reasoning_effort_levels` lists the `reasoning_effort`
 * values the model's chat template renders distinctly, lowest to highest
 * (llama.cpp server README and common/chat.cpp, master).
 *
 * In router mode the model is chosen with `?model=`, and `autoload=false`
 * keeps this from loading a model just to read its properties: the router
 * answers "model is not loaded" instead (tools/server/server-models.cpp).
 */

/**
 * `levels` when llama-server can say; `unavailable` with its reason when it
 * declines (for example "model is not loaded"). Throws when llama-server
 * cannot be reached or fails.
 */
export type ReasoningLevels = { levels: string[] } | { unavailable: string };

export async function getReasoningLevels(
  baseUrl: string,
  model: string | undefined,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ReasoningLevels> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const query = new URLSearchParams({ autoload: "false" });
  if (model) query.set("model", model);
  const res = await doFetch(
    `${baseUrl.replace(/\/+$/, "")}/props?${query.toString()}`,
    options.signal ? { signal: options.signal } : {},
  );
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    chat_template_caps?: { reasoning_effort_levels?: unknown };
  };
  const message =
    body.error?.message ?? `llama-server /props returned ${res.status}`;
  if (res.status >= 400 && res.status < 500) return { unavailable: message };
  if (!res.ok) throw new Error(message);
  const levels = body.chat_template_caps?.reasoning_effort_levels;
  return {
    levels: Array.isArray(levels)
      ? levels.filter((l): l is string => typeof l === "string")
      : [],
  };
}
