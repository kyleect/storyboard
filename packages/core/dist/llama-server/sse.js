/**
 * Reads a server-sent events body and yields each event's `data`.
 * Comment lines (starting with `:`) are skipped; llama-server sends `:` as a
 * keepalive ping. Multiple `data:` lines in one event are joined with `\n`.
 */
export async function* readSseData(body) {
    const decoder = new TextDecoder();
    let buffer = "";
    let data = [];
    const reader = body.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf("\n")) !== -1) {
                let line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line.endsWith("\r"))
                    line = line.slice(0, -1);
                if (line === "") {
                    if (data.length > 0) {
                        yield data.join("\n");
                        data = [];
                    }
                }
                else if (line.startsWith(":")) {
                    // comment / keepalive
                }
                else if (line.startsWith("data:")) {
                    const value = line.slice(5);
                    data.push(value.startsWith(" ") ? value.slice(1) : value);
                }
                // Other fields (event, id, retry) are not used by llama-server here.
            }
        }
        buffer += decoder.decode();
        if (buffer.startsWith("data:")) {
            const value = buffer.slice(5);
            data.push(value.startsWith(" ") ? value.slice(1) : value);
        }
        if (data.length > 0)
            yield data.join("\n");
    }
    finally {
        // Closes the connection if the consumer stopped early.
        await reader.cancel().catch(() => { });
    }
}
//# sourceMappingURL=sse.js.map