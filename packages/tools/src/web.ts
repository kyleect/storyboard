import TurndownService from "turndown";
import { z } from "zod";
import { defineTool } from "@harness/core";

/*
 * Web tools. Fetched HTML is converted to Markdown with Turndown. The
 * contents of <style>, <script> and <noscript> are dropped first, so no CSS
 * or JavaScript ends up in the Markdown.
 */

const turndown = new TurndownService().remove(["style", "script", "noscript"]);

/** Converts an HTML page to Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export const webSearch = defineTool({
  name: "web_search",
  description: "Search the internet using a query",
  input: z.object({
    query: z.string(),
  }),
  approval: "never",
  execute: async ({ query }) => {
    const q = encodeURIComponent(query);
    const response = await fetch(`https://html.duckduckgo.com/html?q=${q}`);

    if (!response.ok) {
      throw new Error(
        "There was an error trying search the internet. No additional details found.",
      );
    }

    const text = await response.text();

    return {
      data: {
        results_markdown: htmlToMarkdown(text),
      },
    };
  },
});

export const readWebpage = defineTool({
  name: "read_webpage",
  description: "Read a webpage at a given url",
  input: z.object({
    url: z.string(),
  }),
  approval: "never",
  execute: async ({ url }) => {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        "There was an error fetching url. No additional details found.",
      );
    }

    const text = await response.text();

    return {
      data: {
        webpage_markdown: htmlToMarkdown(text),
      },
    };
  },
});
