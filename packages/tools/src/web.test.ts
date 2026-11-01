import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type ToolContext,
} from "@harness/core";
import {
  htmlToMarkdown,
  parseDuckDuckGoResults,
  readWebpage,
  searchResultsToMarkdown,
  webSearch,
} from "./web.js";

const ctx: ToolContext = {
  signal: new AbortController().signal,
  sessionId: "s",
  runId: "r",
  callId: "c",
  update: () => {},
  state: undefined,
  projectId: null,
  entries: createEntryAccess({
    session: replaySessionEntries([]),
    sessionOps: [],
    inProject: false,
    author: { by: "model", sessionId: "s", runId: "r" },
  }),
};

const PAGE = `<html><head><title>T</title>
<style>p { color: red }</style><script>var x = 1;</script></head>
<body><noscript>Enable JS</noscript>
<h1>Hello</h1><p>A <a href="https://example.com">link</a>.</p></body></html>`;

/** Replaces fetch; records the URLs asked for. */
function fakeFetch(status: number, body: string) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(body, { status }));
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("htmlToMarkdown", () => {
  it("converts HTML and drops style, script and noscript contents", () => {
    expect(htmlToMarkdown(PAGE)).toBe(
      "T \n\nHello\n=====\n\nA [link](https://example.com).",
    );
  });
});

/** A trimmed DuckDuckGo HTML results page: two results and an ad. */
const DDG_PAGE = `<html><body>
<form id="search_form"><input name="q" value="query"></form>
<div id="links" class="results">
  <div class="result results_links results_links_deep result--ad">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Buy Now</a></h2>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=ads.example">An ad.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstory%3Fa%3D1&amp;rut=abc">Story   [Structure]</a>
      </h2>
      <div class="result__extras"><a class="result__url" href="#">example.com/story</a></div>
      <a class="result__snippet" href="#">How a <b>short story</b>
        is built.</a>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a class="result__a" href="https://example.org/plot">Plot</a></h2>
    </div>
  </div>
</div>
<div class="nav-link"><form><input type="submit" value="Next"></form></div>
<div id="footer">Footer text</div>
</body></html>`;

const DDG_RESULTS = [
  {
    title: "Story [Structure]",
    url: "https://example.com/story?a=1",
    snippet: "How a short story is built.",
  },
  { title: "Plot", url: "https://example.org/plot", snippet: "" },
];

describe("parseDuckDuckGoResults", () => {
  it("reads organic results, skipping ads and unwrapping links", () => {
    expect(parseDuckDuckGoResults(DDG_PAGE)).toEqual({
      kind: "results",
      results: DDG_RESULTS,
    });
  });

  it("returns no results for an empty results list", () => {
    expect(
      parseDuckDuckGoResults(
        `<div id="links"><div class="no-results">No results.</div></div>`,
      ),
    ).toEqual({ kind: "results", results: [] });
  });

  it("detects the bot check page", () => {
    expect(parseDuckDuckGoResults(`<form id="challenge-form"></form>`)).toEqual(
      { kind: "challenge" },
    );
  });

  it("reports a page without a results list as unrecognized", () => {
    expect(parseDuckDuckGoResults(PAGE)).toEqual({ kind: "unrecognized" });
  });
});

describe("searchResultsToMarkdown", () => {
  it("formats results as a numbered list", () => {
    expect(searchResultsToMarkdown(DDG_RESULTS)).toBe(
      "1. [Story \\[Structure\\]](<https://example.com/story?a=1>)\n" +
        "   How a short story is built.\n" +
        "2. [Plot](<https://example.org/plot>)",
    );
  });

  it("says when there are no results", () => {
    expect(searchResultsToMarkdown([])).toBe("No results.");
  });
});

describe("web_search", () => {
  it("searches DuckDuckGo and returns only the results as Markdown", async () => {
    const urls = fakeFetch(200, DDG_PAGE);
    expect(await webSearch.execute({ query: "a b&c" }, ctx)).toEqual({
      data: { results_markdown: searchResultsToMarkdown(DDG_RESULTS) },
    });
    expect(urls).toEqual(["https://html.duckduckgo.com/html?q=a%20b%26c"]);
  });

  it("falls back to the whole page when the results can't be found", async () => {
    fakeFetch(200, PAGE);
    expect(await webSearch.execute({ query: "x" }, ctx)).toEqual({
      data: { results_markdown: htmlToMarkdown(PAGE) },
    });
  });

  it("throws when DuckDuckGo serves a bot check", async () => {
    fakeFetch(
      200,
      `<html><body><form id="challenge-form"></form></body></html>`,
    );
    await expect(webSearch.execute({ query: "x" }, ctx)).rejects.toThrow(
      /bot check/,
    );
  });

  it("throws when the request fails", async () => {
    fakeFetch(500, "");
    await expect(webSearch.execute({ query: "x" }, ctx)).rejects.toThrow(
      /error trying search the internet/,
    );
  });
});

describe("read_webpage", () => {
  it("fetches the URL and returns the page as Markdown", async () => {
    const urls = fakeFetch(200, PAGE);
    expect(
      await readWebpage.execute({ url: "https://example.com/a" }, ctx),
    ).toEqual({ data: { webpage_markdown: htmlToMarkdown(PAGE) } });
    expect(urls).toEqual(["https://example.com/a"]);
  });

  it("throws when the request fails", async () => {
    fakeFetch(404, "");
    await expect(
      readWebpage.execute({ url: "https://example.com/a" }, ctx),
    ).rejects.toThrow(/error fetching url/);
  });
});
