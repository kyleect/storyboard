import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEventStream } from "./event-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  giveUp() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const original = globalThis.EventSource;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.EventSource = original;
});

const last = () => FakeEventSource.instances.at(-1) as FakeEventSource;

describe("connectEventStream", () => {
  it("opens the stream and passes on its messages and opening", () => {
    const onOpen = vi.fn();
    const onMessage = vi.fn();

    connectEventStream({ url: () => "/events", onOpen, onMessage });

    expect(last().url).toBe("/events");
    last().onopen?.();
    expect(onOpen).toHaveBeenCalledOnce();

    const message = { data: "{}" } as MessageEvent<string>;

    last().onmessage?.(message);
    expect(onMessage).toHaveBeenCalledWith(message);
  });

  it("opens a new stream when the browser gives up, asking for the address again", () => {
    let from = 0;

    connectEventStream({
      url: () => `/events?from=${from}`,
      onMessage: () => {},
    });
    from = 7;
    last().giveUp();

    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(last().url).toBe("/events?from=7");
  });

  it("waits twice as long after each failure, up to five seconds", () => {
    connectEventStream({ url: () => "/events", onMessage: () => {} });
    const waits: number[] = [];

    for (let i = 0; i < 6; i++) {
      const before = FakeEventSource.instances.length;

      last().giveUp();
      let waited = 0;

      while (FakeEventSource.instances.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }

      waits.push(waited);
    }

    expect(waits).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("starts the delays over once a stream opens", () => {
    connectEventStream({ url: () => "/events", onMessage: () => {} });
    last().giveUp();
    vi.advanceTimersByTime(500);
    last().giveUp();
    vi.advanceTimersByTime(1000);
    last().onopen?.();
    last().giveUp();

    vi.advanceTimersByTime(499);
    expect(FakeEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("leaves a stream the browser is still retrying alone, and says it failed", () => {
    const onError = vi.fn();

    connectEventStream({
      url: () => "/events",
      onMessage: () => {},
      onError,
    });
    last().onerror?.();

    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes the stream and cancels a pending reconnection", () => {
    const disconnect = connectEventStream({
      url: () => "/events",
      onMessage: () => {},
    });

    last().giveUp();
    disconnect();
    vi.advanceTimersByTime(10_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(last().readyState).toBe(FakeEventSource.CLOSED);
  });
});
