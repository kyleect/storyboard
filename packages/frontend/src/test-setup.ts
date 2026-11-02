import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/*
 * jsdom has no matchMedia, ResizeObserver, document.fonts or
 * scrollIntoView, which Mantine uses (the autosize Textarea listens on
 * document.fonts; a Select's dropdown scrolls to its selected option);
 * these stand-ins do nothing.
 */

window.matchMedia ??= (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

if (!("fonts" in document)) {
  Object.defineProperty(document, "fonts", {
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);
