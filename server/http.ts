// The one HTTP client of the plugin: one streamed POST, with a deadline on silence and a cap on the size of the answer.
import { request as plain } from "node:http";
import { request as tls } from "node:https";

/**
 * An answer that streams: a 200 goes to `onText` piece by piece as it arrives, any other status is read and dropped; the promise is the
 * status at the end. The deadline is silence (`idleMs` without a byte), not the whole exchange, because a long answer keeps talking.
 */
export function stream(to: URL, path: string, headers: Record<string, string>, body: string, idleMs: number, maxBytes: number, onText: (text: string) => void) {
  const decoder = new TextDecoder(); // a character split between two chunks is joined, not cut
  const deadline = new AbortController();
  let timer = setTimeout(() => deadline.abort(), idleMs);
  const request = to.protocol === "https:" ? tls : plain;
  return new Promise<number>((resolve, reject) => {
    const options = { hostname: to.hostname, port: to.port || undefined, method: "POST", path, headers, agent: false, signal: deadline.signal };
    const req = request(options, (res) => {
      const status = res.statusCode ?? 0;
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        clearTimeout(timer);
        timer = setTimeout(() => deadline.abort(), idleMs);
        size += chunk.length;
        if (size > maxBytes) req.destroy();
        else if (status === 200) onText(decoder.decode(chunk, { stream: true }));
      });
      res.on("end", () => resolve(status));
      res.on("close", () => reject(new Error("closed"))); // after "end" the promise is settled: this only ends a cut answer
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  }).finally(() => clearTimeout(timer));
}
