export const modelKeys = {
  all: ["models"] as const,
  list: () => [...modelKeys.all, "list"] as const,
  reasoningLevels: () => [...modelKeys.all, "reasoning-levels"] as const,
  reasoningLevel: (model: string | null | undefined) =>
    [...modelKeys.reasoningLevels(), model ?? null] as const,
  contextSize: (model: string | null | undefined) =>
    [...modelKeys.all, "context-size", model ?? null] as const,
};
