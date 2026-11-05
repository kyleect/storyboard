/*
 * Changed fields between two JSON values, and building the value the user
 * approved (schemas and data design, decisions 31 to 33). A change's path is
 * a JSON Pointer (RFC 6901). Objects are compared by field; lists by
 * position, so each added, removed or changed item is its own change, and
 * the fields of an item present on both sides are compared too (decision
 * 32). Anything else that differs is changed as a whole.
 */

import type { ChangeRecord } from "./review.js";

/** One changed field or list item. */
export type Change = ChangeRecord;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Joins a pointer and one step. */
export const pointer = (base: string, step: string | number): string =>
  `${base}/${escape(String(step))}`;

/** The steps of a JSON Pointer, unescaped. */
export const pointerSteps = (path: string): string[] =>
  path === ""
    ? []
    : path
        .slice(1)
        .split("/")
        .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The changes that turn `before` into `after`, in document order. */
export function changesBetween(
  before: unknown,
  after: unknown,
  path = "",
): Change[] {
  if (before === undefined && after === undefined) return [];
  if (before === undefined) {
    // Each field of a new object is its own change, so the user can leave
    // optional ones out (decision 35b).
    if (isObject(after) && Object.keys(after).length > 0) {
      return Object.entries(after).flatMap(([k, v]) =>
        changesBetween(undefined, v, pointer(path, k)),
      );
    }
    return [{ path, kind: "added", after }];
  }
  if (after === undefined) return [{ path, kind: "removed", before }];
  if (isObject(before) && isObject(after)) {
    const keys = [
      ...Object.keys(before),
      ...Object.keys(after).filter((k) => !(k in before)),
    ];
    return keys.flatMap((k) =>
      changesBetween(before[k], after[k], pointer(path, k)),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Change[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const p = pointer(path, i);
      if (i >= before.length)
        out.push({ path: p, kind: "added", after: after[i] });
      else if (i >= after.length)
        out.push({ path: p, kind: "removed", before: before[i] });
      else out.push(...changesBetween(before[i], after[i], p));
    }
    return out;
  }
  return same(before, after) ? [] : [{ path, kind: "changed", before, after }];
}

/**
 * The value with only the approved changes applied: an approved path takes
 * `after`'s side, every other path keeps `before`'s (decision 32). For a new
 * object, a field left out is absent, and so is the object with none.
 */
export function applySelection(
  before: unknown,
  after: unknown,
  approved: ReadonlySet<string>,
  path = "",
): unknown {
  if (approved.has(path)) return after;
  if (before === undefined) {
    // A new object holds its approved fields; it is absent with none.
    if (!isObject(after)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(after)) {
      const kept = applySelection(undefined, v, approved, pointer(path, k));
      if (kept !== undefined) out[k] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (after === undefined) return before;
  if (isObject(before) && isObject(after)) {
    const b = before;
    const out: Record<string, unknown> = {};
    const keys = [
      ...Object.keys(b),
      ...Object.keys(after).filter((k) => !(k in b)),
    ];
    for (const k of keys) {
      const v = applySelection(b[k], after[k], approved, pointer(path, k));
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: unknown[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const v = applySelection(before[i], after[i], approved, pointer(path, i));
      // A removed item that is not approved stays; an added one that is not
      // approved stays out.
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  return before;
}
