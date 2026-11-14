const FIRST_RETRY_MS = 500;
const LONGEST_RETRY_MS = 5000;

interface EventStreamOptions {
  url: () => string;
  onOpen?: () => void;
  onMessage: (message: MessageEvent<string>) => void;
  onError?: () => void;
}

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
