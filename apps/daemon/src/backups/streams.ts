import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Duplex, Transform } from "node:stream";
import zlib from "node:zlib";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";

// The streams a backup goes through on this computer (ADR-044): zstd,
// then age, then a tap counting bytes and hashing them.
//
// zstd: Node's own (node:zlib, from Node 22.15), so nothing needs
// installing; on an older Node, the `zstd` binary when it is there.
// age: the age-encryption package (by age's author), in JavaScript.

type ZlibZstd = {
  createZstdCompress?: (o?: object) => Transform;
  createZstdDecompress?: (o?: object) => Transform;
  constants: Record<string, number>;
};
const z = zlib as unknown as ZlibZstd;

/** Which zstd is in use, in words. */
export function zstdEngine(): "node" | "binary" {
  return z.createZstdCompress ? "node" : "binary";
}

function binary(args: string[]): Duplex {
  const child = spawn("zstd", args, { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const d = Duplex.from({ writable: child.stdin, readable: child.stdout });
  child.on("error", () =>
    d.destroy(
      new Error(
        "zstd isn't available: Oraknid needs Node 22.15 or newer, or the zstd program installed.",
      ),
    ),
  );
  child.on("close", (code) => {
    if (code) d.destroy(new Error(`zstd stopped: ${err.trim() || `exit ${code}`}`));
  });
  return d;
}

export function zstdCompress(): Duplex {
  if (z.createZstdCompress)
    return z.createZstdCompress({
      params: { [z.constants.ZSTD_c_compressionLevel as number]: 6 },
    });
  return binary(["-q", "-c", "-6", "-T0"]);
}

export function zstdDecompress(): Duplex {
  if (z.createZstdDecompress) return z.createZstdDecompress();
  return binary(["-q", "-d", "-c"]);
}

/** The stream encrypted to one age recipient (age1…). */
export function ageEncrypt(recipient: string) {
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Uint8Array> {
    const e = new Encrypter();
    e.addRecipient(recipient);
    const out = await e.encrypt(ReadableStream.from(source) as ReadableStream<Uint8Array>);
    for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) yield chunk;
  };
}

/** The stream decrypted with an age identity (AGE-SECRET-KEY-1…). */
export function ageDecrypt(identity: string) {
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Uint8Array> {
    const d = new Decrypter();
    d.addIdentity(identity);
    let out: ReadableStream<Uint8Array>;
    try {
      out = await d.decrypt(ReadableStream.from(source) as ReadableStream<Uint8Array>);
    } catch (error) {
      throw new Error(
        `It can't be decrypted with its key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) yield chunk;
    } catch (error) {
      throw new Error(
        `It can't be decrypted: it was changed or damaged after it was made (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  };
}

/** A new age X25519 key pair. */
export async function newAgeKey(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** The public key of a private one, or a plain-words error. */
export async function recipientOf(identity: string): Promise<string> {
  const id = identity.trim();
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(id))
    throw new Error("That isn't an age private key: it starts with AGE-SECRET-KEY-1.");
  try {
    return await identityToRecipient(id);
  } catch {
    throw new Error("That age private key is damaged: it can't be read.");
  }
}

/** Counts and hashes what passes. */
export function tap() {
  const hash = createHash("sha256");
  const t = { size: 0, checksum: "", stream: new Transform() };
  t.stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      t.size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
    flush(cb) {
      t.checksum = hash.digest("hex");
      cb();
    },
  });
  return t;
}

/** Keeps the first and last bytes of what passes (for Verify), and drops the rest. */
export class Ends extends Transform {
  head = Buffer.alloc(0);
  tail = Buffer.alloc(0);
  size = 0;
  constructor(private readonly keep = 64 * 1024) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.size += chunk.length;
    if (this.head.length < this.keep)
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.keep - this.head.length)]);
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-this.keep);
    cb();
  }
}
