/**
 * Reads a server-sent events body and yields each event's `data`.
 * Comment lines (starting with `:`) are skipped; llama-server sends `:` as a
 * keepalive ping. Multiple `data:` lines in one event are joined with `\n`.
 */
export declare function readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string>;
