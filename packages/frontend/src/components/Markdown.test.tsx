import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

function show(source: string) {
  return render(
    <MantineProvider>
      <Markdown>{source}</Markdown>
    </MantineProvider>,
  );
}

describe("Markdown", () => {
  it("renders headings, emphasis and inline code", () => {
    const { container } = show(
      "# Title\n\nSome **bold**, *italic* and `code`.",
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(container.textContent).toContain("Some bold, italic and code.");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("renders bulleted and numbered lists", () => {
    const { container } = show("- one\n- two\n\n3. three\n4. four");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("renders a table", () => {
    const { container } = show("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.querySelector("td")?.textContent).toBe("1");
  });

  it("renders a task list with checkboxes", () => {
    show("- [x] done\n- [ ] not yet");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });

  it("renders a fenced block as a code block with its text", () => {
    const { container } = show("```ts\nconst a = 1;\n```");
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("const a = 1;");
  });

  it("shows raw HTML as text and does not render it", () => {
    const { container } = show("Hi <b>there</b>\n\n<script>alert(1)</script>");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<b>there</b>");
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("shows an image as its alt text and never as an image", () => {
    const { container } = show(
      "Before ![a red barn](https://example.com/x.png) after",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("example.com/x.png");
    expect(container.textContent).toContain("Before a red barn after");
  });

  it("opens https and mailto links in a new tab", () => {
    show("[web](https://example.com) and [mail](mailto:a@b.co)");
    for (const name of ["web", "mail"]) {
      const a = screen.getByRole("link", { name }) as HTMLAnchorElement;
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
    expect(
      (screen.getByRole("link", { name: "web" }) as HTMLAnchorElement).href,
    ).toBe("https://example.com/");
  });

  it("does not make other links clickable but keeps their text", () => {
    const { container } = show(
      "[js](javascript:alert(1)) [rel](/settings) [file](file:///etc/passwd)",
    );
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("js rel file");
  });

  it("keeps single line breaks inside a paragraph", () => {
    const { container } = show("line one\nline two");
    const p = container.querySelector("p");
    expect(p?.textContent).toBe("line one\nline two");
    expect(p?.style.whiteSpace).toBe("pre-wrap");
  });
});
