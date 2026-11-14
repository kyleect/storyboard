export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export function parseEnv(text: string): Record<string, string> {
  return parsePairs(text, "=", "NAME=value");
}

export function parseHeaders(text: string): Record<string, string> {
  return parsePairs(text, ":", "Name: value");
}

function parsePairs(
  text: string,
  separator: string,
  shape: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const line of parseLines(text)) {
    const at = line.indexOf(separator);
    const key = at < 1 ? "" : line.slice(0, at).trim();

    if (key === "") {
      throw new Error(`"${line}" is not in the form ${shape}.`);
    }

    out[key] = line.slice(at + 1).trim();
  }

  return out;
}

export const formatLines = (list: readonly string[]): string => list.join("\n");

export const formatEnv = (env: Readonly<Record<string, string>>): string =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

export const formatHeaders = (
  headers: Readonly<Record<string, string>>,
): string =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
