export const blobKeys = {
  all: ["blobs"] as const,
  file: (hash: string) => [...blobKeys.all, hash] as const,
  text: (hash: string) => [...blobKeys.all, hash, "text"] as const,
  describer: () => [...blobKeys.all, "describer"] as const,
};
