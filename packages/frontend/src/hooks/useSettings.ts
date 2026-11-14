import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { settingsKeys } from "../queries";

export function useSettings() {
  return useQuery({ queryKey: settingsKeys.all, queryFn: api.getSettings });
}
