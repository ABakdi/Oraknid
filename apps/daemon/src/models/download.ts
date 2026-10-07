import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

// A model file's download (ADR-054): resumable (a `.part` file picked up
// with a Range request), with progress, and checked against the checksum
// its source gives before it takes its name.

export interface DownloadOptions {
  url: string;
  dest: string;
  sha256: string | null;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Bytes so far and in all (null while not known). */
  onProgress?: (done: number, total: number | null) => void;
}

export class ChecksumMismatch extends Error {}

/** Resolves once `dest` is complete and checked; a pause (abort) keeps the part for later. */
export async function download(o: DownloadOptions): Promise<{ bytes: number }> {
  if (existsSync(o.dest)) return { bytes: statSync(o.dest).size };
  const part = `${o.dest}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await (o.fetch ?? fetch)(o.url, {
    headers: { "user-agent": "Oraknid", ...(have ? { range: `bytes=${have}-` } : {}) },
    redirect: "follow",
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (res.status === 416 && have) {
    // Already whole: the server has nothing past what we have.
  } else if (!res.ok || !res.body) {
    throw new Error(`The download answered ${res.status} ${res.statusText} for ${o.url}`);
  } else {
    const resumed = res.status === 206 && have > 0;
    const length = Number(res.headers.get("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length + (resumed ? have : 0) : null;
    let done = resumed ? have : 0;
    let last = 0;
    const counter = new TransformCounter((n) => {
      done += n;
      const now = Date.now();
      if (now - last >= 250) {
        last = now;
        o.onProgress?.(done, total);
      }
    });
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(part, { flags: resumed ? "a" : "w" }),
      ...(o.signal ? [{ signal: o.signal }] : []),
    );
    o.onProgress?.(done, total ?? done);
  }
  if (o.sha256) {
    const sum = await sha256Of(part);
    if (sum !== o.sha256.toLowerCase()) {
      rmSync(part, { force: true });
      throw new ChecksumMismatch(
        `The downloaded file's checksum doesn't match its source's (${sum.slice(0, 12)}… instead of ${o.sha256.slice(0, 12)}…): it was removed; download it again.`,
      );
    }
  }
  renameSync(part, o.dest);
  return { bytes: statSync(o.dest).size };
}

export async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

class TransformCounter extends Transform {
  constructor(private readonly onBytes: (n: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}
