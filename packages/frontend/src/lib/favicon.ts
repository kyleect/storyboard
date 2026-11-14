import type { MantineTheme } from "@mantine/core";

export const ICON_URL = "/favicon.svg";
const ICON_TYPE = "image/svg+xml";
const SIZE = 64;

/** The dot is drawn in the icon's own 64-unit grid: a white ring, then the colour. */
export const COLORS = {
  waiting: "#f59e0b",
  unread: "#40c057",
  working: ["#9ca3af", "#4b5563"],
} as const;

/** How long each of the two grays shows. */
export const PULSE_MS = 1000;

const DOT = { x: 50, y: 50, ring: 12, fill: 9 };

/** The robot, in a 64-unit grid, with the accent colours given. */
export function robotSvg(eye: string, tip: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<line x1="18" y1="11" x2="13" y2="4" stroke="#64748B" stroke-width="3" stroke-linecap="round"/>` +
    `<circle cx="12" cy="3.5" r="3.5" fill="${tip}"/>` +
    `<rect x="4" y="10" width="56" height="50" rx="9" fill="#CBD5E1" stroke="#64748B" stroke-width="3"/>` +
    `<rect x="11" y="17" width="42" height="30" rx="5" fill="#1E293B"/>` +
    `<rect x="18" y="25" width="8" height="11" rx="2.5" fill="${eye}"/>` +
    `<rect x="38" y="25" width="8" height="11" rx="2.5" fill="${eye}"/>` +
    `<path d="M25 41.5 Q32 46 39 41.5" fill="none" stroke="${eye}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<rect x="19" y="51.5" width="26" height="4" rx="2" fill="#64748B"/>` +
    `</svg>`
  );
}

const svgUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** The accent colours: the primary colour's shade 4 for the face, and the
 * primary shade (6 by default) for the antenna tip. */
export function accentColors(theme: MantineTheme): {
  eye: string;
  tip: string;
} {
  const palette = theme.colors[theme.primaryColor];
  const shade =
    typeof theme.primaryShade === "number"
      ? theme.primaryShade
      : theme.primaryShade.light;
  return { eye: palette?.[4] ?? "#4dabf7", tip: palette?.[shade] ?? "#228be6" };
}

function loadIcon(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(SIZE, SIZE);
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The favicon did not load."));
    image.src = src;
  });
}

/** The icon with the dot, as a PNG data URL; null if there is no canvas. */
export function withIndicator(
  icon: CanvasImageSource,
  dotColor: string,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(icon, 0, 0, SIZE, SIZE);
  for (const [radius, color] of [
    [DOT.ring, "#ffffff"],
    [DOT.fill, dotColor],
  ] as const) {
    ctx.beginPath();
    ctx.arc(DOT.x, DOT.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}

/** The page's icon tag; made if index.html has none. */
function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

/** The type has to match the address, or the browser may ignore the icon. */
function setIcon(link: HTMLLinkElement, href: string, type: string) {
  link.type = type;
  link.href = href;
}

/**
 * Shows the robot with a dot of `dotColor`, or without one when it is null.
 * The dot needs the icon drawn onto a canvas, which takes a moment; the
 * returned function cancels a draw that has not finished.
 */
export function showIcon(
  eye: string,
  tip: string,
  dotColor: string | null,
): () => void {
  const link = iconLink();
  const icon = svgUrl(robotSvg(eye, tip));
  if (dotColor === null) {
    setIcon(link, icon, ICON_TYPE);
    return () => {};
  }
  let cancelled = false;
  loadIcon(icon)
    .then((image) => {
      if (cancelled) return;
      const href = withIndicator(image, dotColor);
      if (href) setIcon(link, href, "image/png");
    })
    .catch(() => {
      // Keep the plain icon.
    });
  return () => {
    cancelled = true;
  };
}
