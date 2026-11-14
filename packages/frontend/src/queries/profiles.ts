export const profileKeys = {
  all: ["profiles"] as const,
  list: () => [...profileKeys.all, "list"] as const,
};
