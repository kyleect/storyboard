import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { useUnreadSessions } from "./unread";

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useUnreadSessions", () => {
  it("is empty until the first answer arrives", () => {
    vi.spyOn(api, "listUnreadSessions").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useUnreadSessions(), {
      wrapper: wrapper(),
    });
    expect(result.current.count).toBe(0);
    expect(result.current.ids.size).toBe(0);
  });

  it("gives the ids and how many there are", async () => {
    vi.spyOn(api, "listUnreadSessions").mockResolvedValue({ ids: ["a", "b"] });
    const { result } = renderHook(() => useUnreadSessions(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.ids.has("a")).toBe(true);
    expect(result.current.ids.has("c")).toBe(false);
  });
});
