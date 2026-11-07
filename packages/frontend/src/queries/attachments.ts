/*
 * Query keys for files attached to messages:
 *
 *   ["attachments", id]   the object URL of one file's bytes
 *
 * The bytes under an id never change, so these are never invalidated.
 */
export const attachmentKeys = {
  all: ["attachments"] as const,
  file: (id: string) => [...attachmentKeys.all, id] as const,
};
