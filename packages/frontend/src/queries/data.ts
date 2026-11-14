import type { DataOwner } from "../api";
import { scopeKey } from "./scope";

export const dataKeys = {
  all: ["data"] as const,
  lists: () => [...dataKeys.all, "list"] as const,
  list: (owner: DataOwner, showDeleted: boolean) =>
    [...dataKeys.lists(), scopeKey(owner), { showDeleted }] as const,
  details: () => [...dataKeys.all, "detail"] as const,
  detail: (owner: DataOwner, id: string) =>
    [...dataKeys.details(), scopeKey(owner), id] as const,
  schemaInfos: (owner: DataOwner) =>
    [...dataKeys.all, "schema-infos", scopeKey(owner)] as const,
};

export const schemaKeys = {
  all: [...dataKeys.all, "schemas"] as const,
  lists: () => [...schemaKeys.all, "list"] as const,
  list: (owner: DataOwner, showDeleted: boolean) =>
    [...schemaKeys.lists(), scopeKey(owner), { showDeleted }] as const,
  details: () => [...schemaKeys.all, "detail"] as const,
  detail: (owner: DataOwner, id: string) =>
    [...schemaKeys.details(), scopeKey(owner), id] as const,
  latest: (id: string) => [...schemaKeys.all, "latest", id] as const,
};
