import type { DataOwner } from "../api";
import { scopeKey } from "./scope";

/*
 * Query keys for data and schemas. Schemas share the ["data", …] root, so
 * invalidating `dataKeys.all` refreshes both:
 *
 *   ["data", "list", { scope, id }, { showDeleted }]
 *   ["data", "detail", { scope, id }, dataId]
 *   ["data", "schema-infos", { scope, id }]
 *
 *   ["data", "schemas", "list", { scope, id }, { showDeleted }]
 *   ["data", "schemas", "detail", { scope, id }, schemaId]
 *   ["data", "schemas", "latest", schemaId]
 */
export const dataKeys = {
  all: ["data"] as const,
  lists: () => [...dataKeys.all, "list"] as const,
  list: (owner: DataOwner, showDeleted: boolean) =>
    [...dataKeys.lists(), scopeKey(owner), { showDeleted }] as const,
  details: () => [...dataKeys.all, "detail"] as const,
  detail: (owner: DataOwner, id: string) =>
    [...dataKeys.details(), scopeKey(owner), id] as const,
  /** The schemas an owner can make data from, for naming its data. */
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
  /** The body of a schema's latest version, for the form of new data. */
  latest: (id: string) => [...schemaKeys.all, "latest", id] as const,
};
