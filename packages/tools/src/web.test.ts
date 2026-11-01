import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type ToolContext,
} from "@harness/core";
import {
  htmlToMarkdown,
  MAX_SEARCH_RESULTS,
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

  it("drops images and links that only held an image", () => {
    const html = `<html><body>
      <a href="/"><img src="logo.png" alt="Logo"></a>
      <a href="/home"> <svg><title>Home</title><path d="M0 0"/></svg> </a>
      <p>Before <img src="a.png" alt="A"> after.</p>
      <picture><source srcset="b.webp"><img src="b.png" alt="B"></picture>
      <figure><img src="c.png"><figcaption>Caption</figcaption></figure>
      <p><a href="/more"><img src="arrow.png"> Read more</a></p>
    </body></html>`;
    expect(htmlToMarkdown(html)).toBe(
      "Before after.\n\nCaption\n\n[Read more](/more)",
    );
  });
});

/**
 * A trimmed DuckDuckGo Lite results page: an ad, a result with a snippet,
 * a result without one, and the paging form.
 */
const DDG_PAGE = `<html><body>
<form action="/lite/" method="post"><input name="q" value="query"></form>
<table border="0">
  <tr class="result-sponsored">
    <td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example" class='result-link'>Buy Now</a></td>
  </tr>
  <tr class="result-sponsored">
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>An ad.</td>
  </tr>
  <tr>
    <td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fstory%3Fa%3D1&amp;rut=abc" class='result-link'>Story   [Structure]</a></td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>How a <b>short story</b>
      is built.</td>
  </tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>example.com/story</span></td></tr>
  <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr>
    <td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="https://example.org/plot" class='result-link'>Plot</a></td>
  </tr>
  <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>example.org/plot</span></td></tr>
</table>
<form action="/lite/" method="post"><input type="submit" class="navbutton" value="Next Page &gt;"></form>
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

  it("returns no results when the page says there are none", () => {
    expect(
      parseDuckDuckGoResults(
        `<html><body><table><tr><td>No results.</td></tr></table></body></html>`,
      ),
    ).toEqual({ kind: "results", results: [] });
  });

  it("detects the bot check page", () => {
    expect(parseDuckDuckGoResults(`<form id="challenge-form"></form>`)).toEqual(
      { kind: "challenge" },
    );
  });

  it("drops repeated URLs and stops at the result limit", () => {
    const row = (n: number) =>
      `<tr><td><a class="result-link" href="https://example.com/${n}">R${n}</a></td></tr>` +
      `<tr><td class="result-snippet">S${n}</td></tr>`;
    const rows = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(row).join("");
    const page = parseDuckDuckGoResults(`<table>${rows}</table>`);

    expect(page.kind).toBe("results");
    if (page.kind !== "results") return;
    expect(page.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(page.results.map((r) => r.title)).toEqual(
      Array.from({ length: MAX_SEARCH_RESULTS }, (_, n) => `R${n}`),
    );
    // A repeated link's snippet isn't attached to the result before it.
    expect(page.results[0]?.snippet).toBe("S0");
  });

  it("falls back to the page's outbound links when no results are recognized", () => {
    const html = `<html><body>
      <a href="/lite/">Home</a>
      <a href="https://duckduckgo.com/about">About</a>
      <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>
      <a href="https://example.org/b"> Example   B </a>
      <a href="https://example.org/c"></a>
    </body></html>`;
    expect(parseDuckDuckGoResults(html)).toEqual({
      kind: "links",
      results: [
        { title: "Example A", url: "https://example.com/a", snippet: "" },
        { title: "Example B", url: "https://example.org/b", snippet: "" },
      ],
    });
  });

  it("reports a page with nothing usable as unrecognized", () => {
    expect(
      parseDuckDuckGoResults(`<html><body><p>Something else</p></body></html>`),
    ).toEqual({ kind: "unrecognized" });
  });
});

describe("searchResultsToMarkdown", () => {
  it("writes one line per result", () => {
    expect(searchResultsToMarkdown(DDG_RESULTS)).toBe(
      "- [Story \\[Structure\\]](https://example.com/story?a=1): How a short story is built.\n" +
        "- [Plot](https://example.org/plot)",
    );
  });

  it("escapes characters that would break the link", () => {
    expect(
      searchResultsToMarkdown([
        {
          title: "Plot (narrative)",
          url: "https://en.wikipedia.org/wiki/Plot_(narrative) <x>",
          snippet: "",
        },
      ]),
    ).toBe(
      "- [Plot (narrative)](https://en.wikipedia.org/wiki/Plot_%28narrative%29%20%3Cx%3E)",
    );
  });

  it("says when there are no results", () => {
    expect(searchResultsToMarkdown([])).toBe("No results.");
  });
});

describe("web_search", () => {
  it("searches DuckDuckGo Lite and returns only the results as Markdown", async () => {
    const urls = fakeFetch(200, DDG_PAGE);
    expect(await webSearch.execute({ query: "a b&c" }, ctx)).toEqual({
      data: { results_markdown: searchResultsToMarkdown(DDG_RESULTS) },
    });
    expect(urls).toEqual(["https://lite.duckduckgo.com/lite/?q=a%20b%26c"]);
  });

  it("falls back to the page's links when the results can't be found", async () => {
    fakeFetch(200, PAGE);
    expect(await webSearch.execute({ query: "x" }, ctx)).toEqual({
      data: { results_markdown: "- [link](https://example.com)" },
    });
  });

  it("throws when the page has nothing usable", async () => {
    fakeFetch(200, "<html><body><p>Something else</p></body></html>");
    await expect(webSearch.execute({ query: "x" }, ctx)).rejects.toThrow(
      /no results that could be read/,
    );
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
