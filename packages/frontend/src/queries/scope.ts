export const scopeKey = (s: { scope: string; id?: string }) => ({
  scope: s.scope,
  id: s.id ?? null,
});
