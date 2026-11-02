import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { z } from "zod";
import { defineTool, errorCauses, ToolError } from "@harness/core";

/*
 * Web tools. Fetched HTML is converted to Markdown with Turndown. The
 * contents of <style>, <script> and <noscript> are dropped first, so no CSS
 * or JavaScript ends up in the Markdown. Images are dropped too, along with
 * any link left with no text once its image is gone.
 *
 * Search results are read out of DuckDuckGo Lite's page with selectors and
 * written as one short Markdown line each (title, URL, snippet), so the
 * model gets as little text as possible.
 */

const turndown = new TurndownService().remove(["style", "script", "noscript"]);

/** Image elements. <picture> also holds <source> elements. */
const IMAGE_SELECTOR = "img, picture, svg";

/**
 * Converts an HTML page to Markdown, without images.
 *
 * Images are removed from the parsed page rather than with Turndown's
 * remove(), because Turndown's built-in image rule takes precedence over it.
 */
export function htmlToMarkdown(html: string): string {
  const doc = createDocument(html);
  for (const el of Array.from(doc.querySelectorAll(IMAGE_SELECTOR))) {
    el.remove();
  }
  // Links that only wrapped an image (logos, icons) would become "[](url)".
  for (const link of Array.from(doc.querySelectorAll("a"))) {
    if (!link.textContent?.trim()) link.remove();
  }
  return turndown.turndown(doc as unknown as TurndownService.Node);
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * What a DuckDuckGo Lite results page holds:
 * - "results": the organic results (possibly none).
 * - "links": no results were recognized (e.g. the markup changed), so these
 *   are the page's outbound links instead, without snippets.
 * - "challenge": DuckDuckGo served its bot check instead of results.
 * - "unrecognized": nothing usable was found.
 */
export type ParsedSearchPage =
  | { kind: "results"; results: SearchResult[] }
  | { kind: "links"; results: SearchResult[] }
  | { kind: "challenge" }
  | { kind: "unrecognized" };

/** Most results returned to the model. */
export const MAX_SEARCH_RESULTS = 10;

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

/** True for an http(s) URL that leads off DuckDuckGo. */
function isOutboundUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === "http:" || protocol === "https:") &&
      hostname !== "duckduckgo.com" &&
      !hostname.endsWith(".duckduckgo.com")
    );
  } catch {
    return false;
  }
}

/** Adds a result unless its URL is already listed or the list is full. */
function addResult(results: SearchResult[], result: SearchResult): boolean {
  if (results.length >= MAX_SEARCH_RESULTS) return false;
  if (results.some((r) => r.url === result.url)) return false;
  results.push(result);
  return true;
}

/**
 * Reads the organic results out of a DuckDuckGo Lite results page.
 *
 * Lite lays results out as table rows: a row holding the title link
 * (a.result-link), then a row holding the snippet (td.result-snippet), then
 * rows for the display URL and spacing. Ads use the same rows inside
 * tr.result-sponsored. Links and snippets are walked in document order, and
 * each snippet belongs to the link before it.
 */
export function parseDuckDuckGoResults(html: string): ParsedSearchPage {
  const doc = createDocument(html);

  if (doc.querySelector("form#challenge-form")) {
    return { kind: "challenge" };
  }

  const results: SearchResult[] = [];
  // The result a snippet belongs to; null after an ad or a skipped link, so
  // its snippet isn't attached to the result before it.
  let current: SearchResult | null = null;

  for (const el of Array.from(
    doc.querySelectorAll("a.result-link, td.result-snippet"),
  )) {
    if (el.matches("td.result-snippet")) {
      if (current && !current.snippet) current.snippet = clean(el.textContent);
      continue;
    }

    current = null;
    const href = el.getAttribute("href");
    if (!href || el.closest("tr.result-sponsored")) continue;
    if (href.startsWith(AD_URL_PREFIX)) continue;

    const result = {
      title: clean(el.textContent),
      url: resultUrl(href),
      snippet: "",
    };
    if (addResult(results, result)) current = result;
  }

  if (results.length > 0) return { kind: "results", results };
  if (clean(doc.querySelector("body")?.textContent).includes("No results.")) {
    return { kind: "results", results };
  }

  // Fallback: the page's outbound links, titled by their text.
  for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
    const url = resultUrl(el.getAttribute("href") ?? "");
    const title = clean(el.textContent);
    if (title && isOutboundUrl(url))
      addResult(results, { title, url, snippet: "" });
  }
  if (results.length > 0) return { kind: "links", results };
  return { kind: "unrecognized" };
}

/** Escapes a URL's spaces, parentheses and angle brackets for a Markdown link. */
function markdownUrl(url: string): string {
  return url.replace(
    /[ ()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Formats search results as a Markdown list, one line per result. */
export function searchResultsToMarkdown(results: SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results
    .map((r) => {
      const title = r.title.replace(/[\\[\]]/g, "\\$&");
      const link = `- [${title}](${markdownUrl(r.url)})`;
      return r.snippet ? `${link}: ${r.snippet}` : link;
    })
    .join("\n");
}

/**
 * The text of an error and its causes, for a message: "fetch failed
 * (getaddrinfo ENOTFOUND example.com)". Node's fetch only says "fetch
 * failed"; the reason is in its causes.
 */
export function errorText(err: unknown): string {
  const top = err instanceof Error ? err.message : String(err);
  const causes = errorCauses(err)
    .map((c) => c.message || c.code || c.name)
    .filter((m) => m !== "" && m !== top);
  return causes.length > 0 ? `${top} (${causes.join(": ")})` : top;
}

/**
 * Fetches a URL and reads its body. Throws a `ToolError` that says why,
 * starting with `what`, when the request fails, the server answers with an
 * error status or the body cannot be read (error reporting plan, P3).
 */
async function fetchText(
  url: string,
  what: string,
): Promise<{ response: Response; text: string }> {
  const failed = (err: unknown, step: string): ToolError =>
    new ToolError(`${what}: ${step}${errorText(err)}`, {
      cause: err,
      details: {
        url,
        error: err instanceof Error ? err.name : "Error",
        causes: errorCauses(err),
      },
    });

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw failed(err, "");
  }
  if (!response.ok) {
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new ToolError(`${what}: the server answered ${status}.`, {
      details: responseDetails(url, response),
    });
  }
  try {
    return { response, text: await response.text() };
  } catch (err) {
    throw failed(err, "the response could not be read: ");
  }
}

/** What a response says about itself, for error details. */
function responseDetails(url: string, response: Response) {
  return {
    url,
    finalUrl: response.url || url,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
  };
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
    const url = `https://lite.duckduckgo.com/lite/?q=${q}`;
    const { response, text } = await fetchText(url, "The search failed");
    const page = parseDuckDuckGoResults(text);

    if (page.kind === "challenge") {
      throw new ToolError(
        "The search engine asked for a bot check instead of returning results. Try again later.",
        { details: responseDetails(url, response) },
      );
    }

    if (page.kind === "unrecognized") {
      throw new ToolError(
        "The search engine returned a page with no results that could be read.",
        {
          details: {
            ...responseDetails(url, response),
            bodyLength: text.length,
          },
        },
      );
    }

    return {
      data: { results_markdown: searchResultsToMarkdown(page.results) },
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
    const { text } = await fetchText(url, `Could not read ${url}`);

    return {
      data: {
        webpage_markdown: htmlToMarkdown(text),
      },
    };
  },
});
