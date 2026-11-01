import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEntryAccess,
  replaySessionEntries,
  type ToolContext,
} from "@harness/core";
import { htmlToMarkdown, readWebpage, webSearch } from "./web.js";

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

describe("web_search", () => {
  it("searches DuckDuckGo and returns the results as Markdown", async () => {
    const urls = fakeFetch(200, PAGE);
    expect(await webSearch.execute({ query: "a b&c" }, ctx)).toEqual({
      data: { results_markdown: htmlToMarkdown(PAGE) },
    });
    expect(urls).toEqual(["https://html.duckduckgo.com/html?q=a%20b%26c"]);
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
