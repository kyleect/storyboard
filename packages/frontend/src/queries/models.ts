/*
 * Query keys for what llama-server reports about models:
 *
 *   ["models", "list"]
 *   ["models", "reasoning-levels", model]
 *   ["models", "context-size", model]
 *
 * `model` is `null` for the server's default.
 */
export const modelKeys = {
  all: ["models"] as const,
  list: () => [...modelKeys.all, "list"] as const,
  reasoningLevels: () => [...modelKeys.all, "reasoning-levels"] as const,
  reasoningLevel: (model: string | null | undefined) =>
    [...modelKeys.reasoningLevels(), model ?? null] as const,
  contextSize: (model: string | null | undefined) =>
    [...modelKeys.all, "context-size", model ?? null] as const,
};
