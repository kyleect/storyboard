/*
 * Splitting long file values for search (files and memory design, decision
 * 29; plan S1, S2): pieces of at most `max` characters, no overlap. Splits
 * fall at Markdown headings first, then blank lines, then sentence ends,
 * and only as a last resort inside a sentence. Small neighbouring pieces
 * are packed together up to the limit.
 */

export const CHUNK_SIZE = 1500;

/** Splits `text` into the units at one level, keeping their separators. */
function splitLevel(text: string, level: number): string[] {
  switch (level) {
    case 0:
      // Before each Markdown heading line.
      return text.split(/(?=^#{1,6}\s)/m);
    case 1:
      // After each run of blank lines.
      return text.split(/(?<=\n[ \t]*\n)(?=[^\n])/);
    case 2:
      // After sentence ends.
      return text.split(/(?<=[.!?…]["'”’)\]]*\s+)/);
    default:
      return [];
  }
}

function pieces(text: string, max: number, level: number): string[] {
  if (text.length <= max) return [text];
  if (level > 2) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
    return out;
  }
  const units = splitLevel(text, level);
  if (units.length <= 1) return pieces(text, max, level + 1);
  return units.flatMap((u) => pieces(u, max, level + 1));
}

/** The chunks of a value; empty for blank text. */
export function chunkText(text: string, max = CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces(text, max, 0)) {
    if (current.length + piece.length <= max) {
      current += piece;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c !== "");
}
