/*
 * Query keys for the bytes of binary files and their text:
 *
 *   ["blobs", hash]            the object URL of one file's bytes
 *   ["blobs", hash, "text"]    its description or transcript
 *   ["blobs", "describer"]     whether descriptions are on, and the counts
 *
 * The bytes under a hash never change, so they are never invalidated. The
 * text does, when it is written or edited.
 */
export const blobKeys = {
  all: ["blobs"] as const,
  file: (hash: string) => [...blobKeys.all, hash] as const,
  text: (hash: string) => [...blobKeys.all, hash, "text"] as const,
  describer: () => [...blobKeys.all, "describer"] as const,
};
