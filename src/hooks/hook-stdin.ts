const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Read one hook envelope without allowing an unbounded stdin allocation. */
export function readHookStdin(timeoutMs = 1_000, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      process.stdin.removeAllListeners("error");
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, bytes).toString("utf-8"));
    };
    const timer = setTimeout(() => finish(new Error("stdin read timeout")), timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish(new Error("stdin envelope exceeds size limit"));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => finish());
    process.stdin.on("error", (error) => finish(error));
  });
}
