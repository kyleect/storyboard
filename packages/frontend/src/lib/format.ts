export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : "";
