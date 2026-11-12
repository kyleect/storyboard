import { MantineProvider, type MantineThemeOverride } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type ActiveRun } from "./api";
import { COLORS, ICON_URL, useFaviconIndicator } from "./favicon";

/** What the plain icon's address starts with: the robot as an SVG data URL. */
const PLAIN = /^data:image\/svg\+xml,/;

const DATA_URL = "data:image/png;base64,DOT";

/** jsdom does not load images or draw: these stand-ins stay in the test. */
class FakeImage {
  /** The address the last image was asked to load. */
  static lastSrc = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    FakeImage.lastSrc = value;
    queueMicrotask(() => this.onload?.());
  }
}

const ctx = {
  drawImage: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(() => {
    ctx.fillStyles.push(ctx.fillStyle);
  }),
  /** The colour at each `fill()`, in order. */
  fillStyles: [] as string[],
  fillStyle: "",
};

const link = () =>
  document.querySelector<HTMLLinkElement>(
    'link[rel="icon"]',
  ) as HTMLLinkElement;

function wrapper(theme?: MantineThemeOverride) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <MantineProvider {...(theme ? { theme } : {})}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MantineProvider>
  );
}

/** `waiting` runs wait for the user; `working` runs do not. */
const runs = (waiting: number, working = 0) => ({
  runs: [
    ...Array.from({ length: waiting }, (_, i) => run(`w${i}`, true)),
    ...Array.from({ length: working }, (_, i) => run(`r${i}`, false)),
  ],
});

const run = (id: string, waiting: boolean): ActiveRun => ({
  runId: id,
  sessionId: `s-${id}`,
  sessionTitle: id,
  parentRunId: null,
  agentName: null,
  waiting,
});

const activeRuns = (waiting: number, working = 0) =>
  vi.spyOn(api, "listActiveRuns").mockResolvedValue(runs(waiting, working));

/** `n` chats with a reply not yet seen. */
const unread = (n: number) =>
  vi.spyOn(api, "listUnreadSessions").mockResolvedValue({
    sessions: Array.from({ length: n }, (_, i) => ({
      id: `u${i}`,
      projectId: null,
    })),
  });

beforeEach(() => {
  unread(0);
  document.head.innerHTML = `<link rel="icon" href="${ICON_URL}" type="image/svg+xml" />`;
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(DATA_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  ctx.fillStyles.length = 0;
  document.head.innerHTML = "";
});

function renderWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderHook(() => useFaviconIndicator(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </MantineProvider>
    ),
  });
  return queryClient;
}

describe("useFaviconIndicator", () => {
  it("leaves the plain icon while nothing waits", async () => {
    const spy = activeRuns(0);
    renderHook(() => useFaviconIndicator(), { wrapper: wrapper() });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(link().getAttribute("href")).toMatch(PLAIN);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("draws an orange dot, lower right, while a run waits for the user", async () => {
    activeRuns(1, 1);
    renderHook(() => useFaviconIndicator(), { wrapper: wrapper() });
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    expect(link().type).toBe("image/png");
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    // A white ring, then the orange dot, both centred in the lower-right corner.
    expect(ctx.arc).toHaveBeenNthCalledWith(1, 50, 50, 12, 0, Math.PI * 2);
    expect(ctx.arc).toHaveBeenNthCalledWith(2, 50, 50, 9, 0, Math.PI * 2);
    expect(ctx.fillStyles).toEqual(["#ffffff", "#f59e0b"]);
  });

  it("redraws only when it goes from none waiting to some, not for each new count", async () => {
    const spy = activeRuns(1);
    const queryClient = renderWithClient();
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    spy.mockResolvedValue(runs(2));
    await queryClient.invalidateQueries();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it("brings the plain icon back once nothing waits", async () => {
    const spy = activeRuns(1);
    const queryClient = renderWithClient();
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));

    spy.mockResolvedValue(runs(0, 1));
    await queryClient.invalidateQueries();
    await waitFor(() => expect(link().getAttribute("href")).toMatch(PLAIN));
    expect(link().type).toBe("image/svg+xml");
  });

  it("draws orange, not gray, when one run waits and another works", async () => {
    activeRuns(1, 2);
    renderHook(() => useFaviconIndicator(50), { wrapper: wrapper() });
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    await new Promise((r) => setTimeout(r, 150));
    expect(new Set(ctx.fillStyles)).toEqual(
      new Set(["#ffffff", COLORS.waiting]),
    );
  });

  it("alternates two grays while a run works", async () => {
    activeRuns(0, 1);
    renderHook(() => useFaviconIndicator(50), { wrapper: wrapper() });
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[0]));
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[1]));
    expect(ctx.fillStyles).not.toContain(COLORS.waiting);
    expect(link().type).toBe("image/png");
  });

  it("stays one gray with reduced motion", async () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList;
    try {
      activeRuns(0, 1);
      renderHook(() => useFaviconIndicator(50), { wrapper: wrapper() });
      await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[0]));
      await new Promise((r) => setTimeout(r, 250));
      expect(ctx.fillStyles).not.toContain(COLORS.working[1]);
    } finally {
      window.matchMedia = original;
    }
  });

  it("brings the plain icon back after the last run ends", async () => {
    const spy = activeRuns(0, 1);
    const queryClient = renderWithClient();
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    spy.mockResolvedValue(runs(0, 0));
    await queryClient.invalidateQueries();
    await waitFor(() => expect(link().getAttribute("href")).toMatch(PLAIN), {
      timeout: 2000,
    });
    expect(link().type).toBe("image/svg+xml");
  });

  it("colours the icon from the theme's primary colour", async () => {
    const spy = activeRuns(0);
    renderHook(() => useFaviconIndicator(), {
      wrapper: wrapper({ primaryColor: "grape" }),
    });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const svg = decodeURIComponent(link().getAttribute("href") ?? "");
    // Grape's shade 4 for the face, its primary shade (6) for the antenna tip.
    expect(svg).toContain('fill="#da77f2"');
    expect(svg).toContain('fill="#be4bdb"');
    expect(svg).not.toContain("#4dabf7");
  });

  it("uses Mantine's default blue when the theme sets no colour", async () => {
    const spy = activeRuns(0);
    renderHook(() => useFaviconIndicator(), { wrapper: wrapper() });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const svg = decodeURIComponent(link().getAttribute("href") ?? "");
    expect(svg).toContain('fill="#4dabf7"');
    expect(svg).toContain('fill="#228be6"');
  });

  it("draws the themed robot under the dot too", async () => {
    activeRuns(1);
    renderHook(() => useFaviconIndicator(), {
      wrapper: wrapper({ primaryColor: "teal" }),
    });
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    expect(decodeURIComponent(FakeImage.lastSrc)).toContain('fill="#38d9a9"');
  });

  it("draws a green dot, lower right, while a chat has a reply not yet seen", async () => {
    activeRuns(0);
    unread(2);
    renderHook(() => useFaviconIndicator(), { wrapper: wrapper() });
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    expect(link().type).toBe("image/png");
    expect(ctx.arc).toHaveBeenNthCalledWith(1, 50, 50, 12, 0, Math.PI * 2);
    expect(ctx.arc).toHaveBeenNthCalledWith(2, 50, 50, 9, 0, Math.PI * 2);
    expect(ctx.fillStyles).toEqual(["#ffffff", COLORS.unread]);
  });

  it("brings the plain icon back once the replies are seen", async () => {
    activeRuns(0);
    const spy = unread(1);
    const queryClient = renderWithClient();
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    spy.mockResolvedValue({ sessions: [] });
    await queryClient.invalidateQueries();
    await waitFor(() => expect(link().getAttribute("href")).toMatch(PLAIN));
    expect(link().type).toBe("image/svg+xml");
  });

  it("shows orange, not green, when a run waits and a reply is unseen", async () => {
    activeRuns(1);
    unread(1);
    renderHook(() => useFaviconIndicator(50), { wrapper: wrapper() });
    await waitFor(() => expect(link().getAttribute("href")).toBe(DATA_URL));
    await new Promise((r) => setTimeout(r, 100));
    expect(new Set(ctx.fillStyles)).toEqual(
      new Set(["#ffffff", COLORS.waiting]),
    );
  });

  it("shows the gray pulse, not green, while a run works", async () => {
    activeRuns(0, 1);
    unread(1);
    renderHook(() => useFaviconIndicator(50), { wrapper: wrapper() });
    // The run's state is debounced, so green shows first, as it did before it.
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[0]));
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[1]));
    ctx.fillStyles.length = 0;
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.fillStyles.length).toBeGreaterThan(0);
    expect(ctx.fillStyles).not.toContain(COLORS.unread);
  });

  it("goes from the pulse to green when the run ends with a reply unseen", async () => {
    const spy = activeRuns(0, 1);
    unread(1);
    const queryClient = renderWithClient();
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.working[0]));
    spy.mockResolvedValue(runs(0, 0));
    await queryClient.invalidateQueries();
    await waitFor(() => expect(ctx.fillStyles).toContain(COLORS.unread), {
      timeout: 2000,
    });
  });

  it("keeps the plain icon if the canvas cannot draw", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const spy = activeRuns(1);
    renderHook(() => useFaviconIndicator(), { wrapper: wrapper() });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(link().getAttribute("href")).toMatch(PLAIN);
  });
});
