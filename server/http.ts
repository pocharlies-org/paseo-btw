// The one HTTP client of the plugin: `node:http` and not fetch, because the fetch of Node adds `Sec-Fetch-Mode`, and the account service
// refuses every request that carries a `Sec-Fetch-*` header (it takes it for a page in a browser). This sends no `Origin` and no
// `Sec-Fetch-*`, and a `Host` of exactly host:port. A deadline, and a cap on the size of the answer.
import { request } from "node:http";

type To = { host: string; port: number };

/**
 * One exchange: `onData` gets every chunk of the answer with its status, and the promise the status at the end. With `idle` the deadline is
 * the silence between chunks instead of the whole exchange.
 */
function exchange(
  to: To,
  method: "GET" | "PATCH" | "POST",
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  idle: boolean,
  maxBytes: number,
  onData: (chunk: Buffer, status: number) => void,
): Promise<number> {
  const deadline = new AbortController();
  let timer = setTimeout(() => deadline.abort(), timeoutMs);
  return new Promise<number>((resolve, reject) => {
    const req = request({ ...to, method, path, headers, agent: false, signal: deadline.signal }, (res) => {
      const status = res.statusCode ?? 0;
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (idle) {
          clearTimeout(timer);
          timer = setTimeout(() => deadline.abort(), timeoutMs);
        }
        size += chunk.length;
        if (size > maxBytes) req.destroy();
        else onData(chunk, status);
      });
      res.on("end", () => resolve(status));
      res.on("close", () => reject(new Error("closed"))); // after "end" the promise is settled: this only ends a cut answer
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  }).finally(() => clearTimeout(timer));
}

/** The whole answer, within one deadline for the whole exchange. */
export async function send(
  to: To,
  method: "GET" | "PATCH" | "POST",
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; text: string }> {
  const chunks: Buffer[] = [];
  const status = await exchange(to, method, path, headers, body, timeoutMs, false, maxBytes, (chunk) => chunks.push(chunk));
  return { status, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * An answer that streams: a 200 goes to `onText` piece by piece as it arrives, any other status is read and dropped. The deadline is
 * silence (`idleMs` without a byte), not the whole exchange, because a long answer keeps talking.
 */
export function stream(to: To, path: string, headers: Record<string, string>, body: string, idleMs: number, maxBytes: number, onText: (text: string) => void) {
  const decoder = new TextDecoder(); // a character split between two chunks is joined, not cut
  return exchange(to, "POST", path, headers, body, idleMs, true, maxBytes, (chunk, status) => {
    if (status === 200) onText(decoder.decode(chunk, { stream: true }));
  });
}
