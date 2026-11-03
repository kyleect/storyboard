/*
 * Task prefixes some embedding models are trained with. nomic-embed-text
 * expects "search_document: " on indexed text and "search_query: " on
 * queries; without them retrieval is weaker. Other models get the text
 * unchanged.
 */

export type EmbedTask = "document" | "query";

const NOMIC: Record<EmbedTask, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

/** The text to send to `model` for `task`. */
export function withTaskPrefix(
  model: string,
  task: EmbedTask,
  text: string,
): string {
  return /nomic-embed-text/i.test(model) ? NOMIC[task] + text : text;
}
