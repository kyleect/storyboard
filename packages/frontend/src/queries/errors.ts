import type { ErrorFilter } from "../api";

export const errorKeys = {
  all: ["errors"] as const,
  lists: () => [...errorKeys.all, "list"] as const,
  list: (filter: ErrorFilter = {}) => [...errorKeys.lists(), filter] as const,
  filters: () => [...errorKeys.all, "filters"] as const,
};
