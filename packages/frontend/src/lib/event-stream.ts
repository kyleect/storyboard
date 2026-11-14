const FIRST_RETRY_MS = 500;
const LONGEST_RETRY_MS = 5000;

interface EventStreamOptions {
  /** Evaluated on every connection, so a reconnect can resume where it left off. */
  url: () => string;
  onOpen?: () => void;
  onMessage: (message: MessageEvent<string>) => void;
  onError?: () => void;
}

/**
 * Opens an `EventSource` and keeps it open. The browser reconnects on its own
 * after a dropped connection but gives up for good when a reconnect gets an
 * error status, which is what the dev proxy returns while the backend
 * restarts; then a new one is opened after a delay that doubles up to five
 * seconds and starts over once a connection opens. Returns the function that
 * closes it.
 */
export function connectEventStream({
  url,
  onOpen,
  onMessage,
  onError,
}: EventStreamOptions): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = FIRST_RETRY_MS;

  const connect = () => {
    source = new EventSource(url());
    source.onopen = () => {
      delay = FIRST_RETRY_MS;
      onOpen?.();
    };
    source.onmessage = onMessage;
    source.onerror = () => {
      onError?.();
      if (source?.readyState === EventSource.CLOSED) {
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, LONGEST_RETRY_MS);
      }
    };
  };
  connect();

  return () => {
    clearTimeout(retry);
    source?.close();
  };
}
