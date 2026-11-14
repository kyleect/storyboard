import { MantineProvider } from "@mantine/core";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptScroll } from "./TranscriptScroll";

/*
 * The transcript starts at the bottom and follows new content while the reader
 * is at the bottom. jsdom has no layout, so the scroll geometry is stubbed and
 * a ResizeObserver that the test can fire stands in for the content growing.
 */

const geometry = { scrollHeight: 1000, clientHeight: 400 };
const tops = new WeakMap<Element, number>();
let observers: Array<() => void> = [];

beforeEach(() => {
  geometry.scrollHeight = 1000;
  geometry.clientHeight = 400;
  observers = [];
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollTop: {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, value: number) {
        tops.set(this, value);
      },
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe() {
        observers.push(this.callback);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const name of ["scrollHeight", "clientHeight", "scrollTop"])
    Reflect.deleteProperty(HTMLElement.prototype, name);

  vi.unstubAllGlobals();
});

const VIEWPORT = ".mantine-ScrollArea-viewport";

function Parent({ scrollTo }: { scrollTo?: number }) {
  useEffect(() => {
    const view = document.querySelector<HTMLElement>(VIEWPORT);

    if (view && scrollTo !== undefined) view.scrollTop = scrollTo;
  }, [scrollTo]);

  return (
    <TranscriptScroll>
      <p>text</p>
    </TranscriptScroll>
  );
}

function show(scrollTo?: number) {
  const { container } = render(
    <MantineProvider>
      <Parent {...(scrollTo === undefined ? {} : { scrollTo })} />
    </MantineProvider>,
  );
  const view = container.querySelector<HTMLElement>(VIEWPORT);

  if (!view) throw new Error("No scroll viewport.");

  return view;
}

function grow(to: number) {
  geometry.scrollHeight = to;
  act(() => observers.forEach((callback) => callback()));
}

function scrollTo(view: HTMLElement, top: number) {
  view.scrollTop = top;
}

describe("TranscriptScroll", () => {
  it("starts at the bottom", () => {
    const view = show();

    expect(view.scrollTop).toBe(1000);
  });

  it("follows the content while at the bottom", () => {
    const view = show();

    grow(1500);
    expect(view.scrollTop).toBe(1500);
    grow(1800);
    expect(view.scrollTop).toBe(1800);
  });

  it("stays where the reader scrolled to", () => {
    const view = show();

    scrollTo(view, 200);
    grow(1500);
    expect(view.scrollTop).toBe(200);
  });

  it("follows again once the reader is back at the bottom", () => {
    const view = show();

    scrollTo(view, 200);
    grow(1500);
    scrollTo(view, 1500 - 400);
    grow(1700);
    expect(view.scrollTop).toBe(1700);
  });

  it("is not pulled back down when something scrolls to a message on arrival", () => {
    const view = show(300);

    expect(view.scrollTop).toBe(300);
    grow(1500);
    expect(view.scrollTop).toBe(300);
  });

  it("follows when the visible area shrinks while at the bottom", () => {
    const view = show();

    geometry.clientHeight = 300;
    act(() => observers.forEach((callback) => callback()));
    expect(view.scrollTop).toBe(1000);
  });
});
