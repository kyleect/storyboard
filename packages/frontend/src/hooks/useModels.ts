import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { modelKeys } from "../queries";

export function useModels() {
  return useQuery({
    queryKey: modelKeys.list(),
    queryFn: api.listModels,
    refetchInterval: (q) =>
      q.state.data?.some((m) => m.status === "loading") ? 1000 : false,
  });
}
