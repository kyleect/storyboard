export const runKeys = {
  all: ["runs"] as const,
  active: () => [...runKeys.all, "active"] as const,
};
