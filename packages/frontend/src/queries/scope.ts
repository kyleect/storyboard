/**
 * A scope or owner as one query-key element: `{ scope, id }`, with
 * `id: null` for the global one, so every scope has the same shape.
 */
export const scopeKey = (s: { scope: string; id?: string }) => ({
  scope: s.scope,
  id: s.id ?? null,
});
