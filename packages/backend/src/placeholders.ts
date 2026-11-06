/*
 * Placeholders in the prompts the user writes (placeholders design). A
 * placeholder is `{{skills}}`, `{{tools}}`, `{{schemas}}`, `{{data}}` or
 * `{{agents}}` (schemas and data design, decision 39); it is replaced, when a
 * run starts, with what the run has access to.
 */

export type PlaceholderName =
  "skills" | "tools" | "schemas" | "data" | "agents";

/** A placeholder, with spaces inside the braces allowed. */
const PLACEHOLDER = /\{\{\s*(skills|tools|schemas|data|agents)\s*\}\}/g;

/**
 * Replaces each placeholder in `text` with its value (decisions 1 to 5). One
 * pass: text that an expansion produces is not scanned again. Anything else
 * in braces, such as a misspelt name, is left as typed.
 */
export function expandPlaceholders(
  text: string,
  values: Record<PlaceholderName, string>,
): string {
  return text.replace(PLACEHOLDER, (_match, name: PlaceholderName) => {
    return values[name];
  });
}

/** Whether `text` has the placeholder, so its default position is not used. */
export function usesPlaceholder(
  text: string | undefined,
  name: PlaceholderName,
): boolean {
  if (text === undefined) return false;
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (m[1] === name) return true;
  }
  return false;
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
