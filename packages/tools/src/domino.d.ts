/*
 * Minimal types for @mixmark-io/domino, the DOM implementation Turndown
 * uses. The package's own typings declare a module named "domino" and rely
 * on the DOM lib, which this project doesn't load, so only the parts the
 * web tools use are declared here.
 */
declare module "@mixmark-io/domino" {
  interface DominoElement {
    readonly textContent: string | null;
    getAttribute(name: string): string | null;
    matches(selector: string): boolean;
    closest(selector: string): DominoElement | null;
    querySelector(selector: string): DominoElement | null;
    querySelectorAll(selector: string): Iterable<DominoElement>;
  }

  interface DominoDocument {
    querySelector(selector: string): DominoElement | null;
    querySelectorAll(selector: string): Iterable<DominoElement>;
  }

  export function createDocument(
    html?: string,
    force?: boolean,
  ): DominoDocument;
}
