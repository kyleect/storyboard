import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { z } from "zod";
import { defineTool } from "@harness/core";

/*
 * Web tools. Fetched HTML is converted to Markdown with Turndown. The
 * contents of <style>, <script> and <noscript> are dropped first, so no CSS
 * or JavaScript ends up in the Markdown.
 *
 * Search results are read out of DuckDuckGo's HTML page with selectors, so
 * the Markdown holds only each result's title, URL and snippet rather than
 * the whole page (search form, filters, paging, footer, ads).
 */

const turndown = new TurndownService().remove(["style", "script", "noscript"]);

/** Converts an HTML page to Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * What a DuckDuckGo HTML results page holds:
 * - "results": the organic results (possibly none).
 * - "challenge": DuckDuckGo served its bot check instead of results.
 * - "unrecognized": the page has no results list, e.g. the markup changed.
 */
export type ParsedSearchPage =
  | { kind: "results"; results: SearchResult[] }
  | { kind: "challenge" }
  | { kind: "unrecognized" };

/** Ads link through this redirect. */
const AD_URL_PREFIX = "https://duckduckgo.com/y.js";

/** Collapses runs of whitespace and trims. */
function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Returns the destination of a result link. DuckDuckGo may wrap it as
 * //duckduckgo.com/l/?uddg=<encoded url>&rut=..., which is unwrapped.
 */
function resultUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (url.hostname === "duckduckgo.com" && url.pathname === "/l/") {
      return url.searchParams.get("uddg") ?? href;
    }
  } catch {
    // Not a URL; return it as given.
  }
  return href;
}

/** Reads the organic results out of a DuckDuckGo HTML results page. */
export function parseDuckDuckGoResults(html: string): ParsedSearchPage {
  const doc = createDocument(html);

  if (doc.querySelector("form#challenge-form")) {
    return { kind: "challenge" };
  }
  if (!doc.querySelector("#links")) {
    return { kind: "unrecognized" };
  }

  const results: SearchResult[] = [];
  // Ads are div.result--ad and lack the web-result class.
  for (const el of doc.querySelectorAll("#links > div.web-result")) {
    const link = el.querySelector("h2 a");
    const href = link?.getAttribute("href");
    if (!link || !href || href.startsWith(AD_URL_PREFIX)) continue;

    results.push({
      title: clean(link.textContent),
      url: resultUrl(href),
      snippet: clean(el.querySelector("a.result__snippet")?.textContent),
    });
  }
  return { kind: "results", results };
}

/** Formats search results as a numbered Markdown list. */
export function searchResultsToMarkdown(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results
    .map((r, i) => {
      const title = r.title.replace(/[[\]]/g, "\\$&");
      const line = `${i + 1}. [${title}](<${r.url}>)`;
      return r.snippet ? `${line}\n   ${r.snippet}` : line;
    })
    .join("\n");
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
    const page = parseDuckDuckGoResults(text);

    if (page.kind === "challenge") {
      throw new Error(
        "The search engine asked for a bot check instead of returning results. Try again later.",
      );
    }

    return {
      data: {
        // If the results can't be found, fall back to the whole page so a
        // markup change degrades the output rather than losing it.
        results_markdown:
          page.kind === "results"
            ? searchResultsToMarkdown(page.results)
            : htmlToMarkdown(text),
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
