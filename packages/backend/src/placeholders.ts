import { formatRef } from "@harness/core";
import Mustache from "mustache";

/*
 * Placeholders in the prompts the user writes (placeholders design). A
 * placeholder is `{{skills}}`, `{{tools}}`, `{{schemas}}`, `{{data}}` or
 * `{{agents}}` (schemas and data design, decision 39), `{{workspaces}}`
 * (files unification design, D39) or `{{files}}`; it is replaced, when a
 * run starts, with what the run has access to. `{{date}}` and `{{time}}` are
 * replaced with the date and the time of day the run starts.
 * Each list also has an `_instruction` placeholder, such as
 * `{{skills_instruction}}`: the wording that introduces the list, from the
 * setting of the same name (`skillsInstruction`), kept apart from the list.
 * It is empty when the list is.
 *
 * A prompt is a Mustache template (mustache.js), so these names can also be
 * used as conditions: `{{#skills}}...{{/skills}}` is kept only when there are
 * skills, `{{^skills}}...{{/skills}}` only when there are none, and
 * `{{! note }}` is a comment. The values are plain text, so nothing is
 * HTML-escaped. Unlike stock Mustache, a name that is not a placeholder is
 * never silently dropped (see `expandPlaceholders`).
 */

export type PlaceholderName =
  | "skills"
  | "tools"
  | "schemas"
  | "data"
  | "agents"
  | "workspaces"
  | "files"
  | "skills_instruction"
  | "tools_instruction"
  | "schemas_instruction"
  | "data_instruction"
  | "agents_instruction"
  | "workspaces_instruction"
  | "files_instruction"
  | "date"
  | "time";

const NAMES: ReadonlySet<string> = new Set<PlaceholderName>([
  "skills",
  "skills_instruction",
  "tools",
  "tools_instruction",
  "schemas",
  "schemas_instruction",
  "data",
  "data_instruction",
  "agents",
  "agents_instruction",
  "workspaces",
  "workspaces_instruction",
  "files",
  "files_instruction",
  "date",
  "time",
]);

/**
 * A prompt that is not a valid template, such as an unclosed `{{`. The
 * message says where, by line and column, and is meant to be shown.
 */
export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderError";
  }
}

/**
 * A mustache.js token: `[type, value, start, end]`, where `start` and `end`
 * are the tag's position in the text; a section also has its tokens and the
 * position of its closing tag.
 */
type Token = [
  type: string,
  value: string,
  start: number,
  end: number,
  children?: Token[],
  closeStart?: number,
];

/**
 * Our own writer, not mustache.js's shared one, so nothing here is global.
 * Its cache is cleared after each use: a prompt is read once per run, and
 * every edit of a prompt would otherwise leave another entry behind.
 */
const writer = new Mustache.Writer();

/** `line 3, column 7` for the character at `index`. */
function where(text: string, index: number): string {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  return `line ${line}, column ${column}`;
}

function parseTokens(text: string): Token[] {
  try {
    return writer.parse(text) as Token[];
  } catch (err) {
    // mustache.js reports `Unclosed tag at 12`: a character index.
    const message = err instanceof Error ? err.message : String(err);
    const m = /^(.*) at (\d+)$/.exec(message);
    throw new PlaceholderError(
      m?.[1] !== undefined && m[2] !== undefined
        ? `${m[1]} (${where(text, Number(m[2]))})`
        : message,
    );
  } finally {
    writer.clearCache();
  }
}

/** What a template uses, found without rendering it. */
interface Scan {
  /** Placeholders written as a variable tag: `{{skills}}`, `{{{skills}}}`, `{{&skills}}`. */
  variables: Set<PlaceholderName>;
  /** Variable tags that name no placeholder, in the order they are written. */
  unknown: Token[];
}

/**
 * Walks a template's tokens. Things that cannot be kept as typed and would
 * otherwise vanish without a trace are refused: a section on a name that is
 * not a placeholder, a partial and a change of delimiters.
 */
function scan(text: string, tokens: readonly Token[], depth = 0): Scan {
  const found: Scan = { variables: new Set(), unknown: [] };
  for (const token of tokens) {
    const [type, value, start] = token;
    switch (type) {
      case "name":
      case "&":
        if (NAMES.has(value)) found.variables.add(value as PlaceholderName);
        // `{{.}}` is the section's own text, so it is fine inside one.
        else if (!(value === "." && depth > 0)) found.unknown.push(token);
        break;
      case "#":
      case "^": {
        if (!NAMES.has(value)) {
          throw new PlaceholderError(
            `"${value}" is not a placeholder, so the section {{${type}${value}}} would be dropped (${where(text, start)})`,
          );
        }
        const inner = scan(text, token[4] ?? [], depth + 1);
        for (const v of inner.variables) found.variables.add(v);
        found.unknown.push(...inner.unknown);
        break;
      }
      case ">":
        throw new PlaceholderError(
          `Partials are not supported (${where(text, start)})`,
        );
      case "=":
        throw new PlaceholderError(
          `Changing the delimiters is not supported (${where(text, start)})`,
        );
    }
  }
  return found;
}

/**
 * What `{{date}}` expands to: the weekday and the date, such as `Friday,
 * November 6, 2026`, in `timeZone` (an IANA name; the computer's own when
 * not given).
 */
export function formatDate(now: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
}

/**
 * What `{{time}}` expands to: the time on a 24-hour clock with the time zone's
 * short name, such as `14:32 PST`, in `timeZone` (the computer's own when not
 * given). It is the time when the run starts, not a clock that keeps moving.
 */
export function formatTime(now: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  })
    .format(now)
    .replace(/^(\d{2}:\d{2})\s+/, "$1 ");
}

/**
 * Renders `text` as a Mustache template over `values` (decisions 1 to 5). One
 * pass: text that an expansion produces is not scanned again. The values are
 * plain text and are not HTML-escaped.
 *
 * A variable tag that names no placeholder, such as a misspelt `{{skils}}`,
 * is left as typed, so the mistake stays visible (decision 3). Mustache
 * would render it as nothing. Anything that cannot be left as typed and
 * would be dropped without a word, and a template that does not parse, throw
 * a `PlaceholderError`.
 */
export function expandPlaceholders(
  text: string,
  values: Record<PlaceholderName, string>,
): string {
  const { unknown } = scan(text, parseTokens(text));
  // Each unknown tag is swapped for a tag on a value that holds the tag's own
  // text, so Mustache writes it back unchanged. Last first, so the positions
  // of the earlier ones still hold.
  const view: Record<string, string> = { ...values };
  let template = text;
  for (let i = unknown.length - 1; i >= 0; i--) {
    const token = unknown[i];
    if (token === undefined) continue;
    const key = `literal${i}`;
    view[key] = text.slice(token[2], token[3]);
    template = `${template.slice(0, token[2])}{{${key}}}${template.slice(token[3])}`;
  }
  try {
    return writer.render(template, view, undefined, {
      escape: (value: string) => value,
    });
  } finally {
    writer.clearCache();
  }
}

/**
 * Whether `text` writes the placeholder as a variable tag, so its default
 * position is not used. A comment, a section on the name and a tag that is
 * not valid do not count.
 */
export function usesPlaceholder(
  text: string | undefined,
  name: PlaceholderName,
): boolean {
  if (text === undefined) return false;
  try {
    return scan(text, parseTokens(text)).variables.has(name);
  } catch (err) {
    if (err instanceof PlaceholderError) return false;
    throw err;
  }
}

/** The first sentence of a tool's description, on one line. */
export function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  return /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/**
 * The tools a run is offered, one per line with the first sentence of each
 * description (decision 7). Empty when there are none.
 */
export function toolsList(
  tools: readonly { name: string; description: string }[],
): string {
  return tools
    .map((t) => `- ${t.name}: ${firstSentence(t.description)}`)
    .join("\n");
}

/**
 * The agents a run can start as subagents, one per line: `- (id) name:
 * description`. The id is what `start_subagent` takes. Empty when there are
 * none. Agents that are not startable are left out here, so a caller can pass
 * everything the session can pick.
 */
export function agentsList(
  agents: readonly {
    id: string;
    name: string;
    description: string;
    subagent: boolean;
  }[],
): string {
  return agents
    .filter((a) => a.subagent)
    .map((a) => {
      const description = a.description.replace(/\s+/g, " ").trim();
      return `- (${a.id}) ${a.name}${description === "" ? "" : `: ${description}`}`;
    })
    .join("\n");
}

/**
 * What `{{workspaces}}` expands to: one line per workspace the run has, with
 * its reference and whether it can be changed. Empty for none.
 */
export function workspacesList(
  workspaces: readonly {
    id: string;
    name: string;
    effectiveWritable: boolean;
  }[],
): string {
  return workspaces
    .map(
      (w) =>
        `- ${w.name}: workspace://${w.id}/ (${w.effectiveWritable ? "can be changed" : "read-only"})`,
    )
    .join("\n");
}

/** The longest description a `{{files}}` line shows, in characters. */
export const FILE_DESCRIPTION_MAX = 120;

/**
 * What `{{files}}` expands to: one line per file in the scopes the run can
 * see, `- <scope://name> (media type): description`. The description is what
 * a binary file's derived text says (a description or transcript), on one
 * line and cut at `FILE_DESCRIPTION_MAX` characters with "…"; a file with none
 * has no colon part. Empty for none.
 */
export function filesList(
  files: readonly {
    scope: "session" | "project" | "global";
    key: string;
    mediaType: string;
    description?: string | undefined;
  }[],
): string {
  return files
    .map((f) => {
      const text = (f.description ?? "").replace(/\s+/g, " ").trim();
      const shown =
        text.length > FILE_DESCRIPTION_MAX
          ? `${text.slice(0, FILE_DESCRIPTION_MAX).trimEnd()}…`
          : text;
      return `- ${formatRef({ location: f.scope, path: f.key })} (${f.mediaType})${shown === "" ? "" : `: ${shown}`}`;
    })
    .join("\n");
}
