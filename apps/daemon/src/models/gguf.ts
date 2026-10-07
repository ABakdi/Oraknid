import { closeSync, openSync, readSync } from "node:fs";

// The few facts a GGUF file says of itself that running it needs: its
// architecture, trained context length and number of layers (for the GPU
// layers when it doesn't fit whole), and its name. Only the header is
// read; big arrays (the tokenizer) are skipped.

export interface GgufInfo {
  architecture: string | null;
  name: string | null;
  contextLength: number | null;
  layers: number | null;
}

const MAGIC = 0x46554747; // "GGUF", little-endian

class Reader {
  #buf = Buffer.alloc(0);
  #pos = 0;
  #filePos = 0;
  constructor(
    private readonly fd: number,
    private readonly limit: number,
  ) {}

  #ensure(n: number) {
    if (this.#pos + n <= this.#buf.length) return;
    if (this.#filePos >= this.limit) throw new Error("GGUF header too large");
    const want = Math.max(n, 1 << 20);
    const chunk = Buffer.alloc(want);
    const got = readSync(this.fd, chunk, 0, want, this.#filePos);
    this.#filePos += got;
    this.#buf = Buffer.concat([this.#buf.subarray(this.#pos), chunk.subarray(0, got)]);
    this.#pos = 0;
    if (this.#buf.length < n) throw new Error("GGUF file ends early");
  }
  u8() {
    this.#ensure(1);
    return this.#buf.readUInt8(this.#pos++);
  }
  u32() {
    this.#ensure(4);
    const v = this.#buf.readUInt32LE(this.#pos);
    this.#pos += 4;
    return v;
  }
  u64() {
    this.#ensure(8);
    const v = this.#buf.readBigUInt64LE(this.#pos);
    this.#pos += 8;
    return Number(v);
  }
  skip(n: number) {
    while (n > 0) {
      const step = Math.min(n, 1 << 20);
      this.#ensure(step);
      this.#pos += step;
      n -= step;
    }
  }
  bytes(n: number) {
    this.#ensure(n);
    const b = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return b;
  }
  string() {
    return this.bytes(this.u64()).toString("utf8");
  }
}

/** Byte sizes of GGUF's scalar types, by type id. */
const SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};

function value(r: Reader, type: number): unknown {
  switch (type) {
    case 0:
    case 7:
      return r.u8();
    case 4:
      return r.u32();
    case 5:
      return r.bytes(4).readInt32LE(0);
    case 6:
      return r.bytes(4).readFloatLE(0);
    case 8:
      return r.string();
    case 10:
      return r.u64();
    case 11:
      return Number(r.bytes(8).readBigInt64LE(0));
    case 12:
      return r.bytes(8).readDoubleLE(0);
    case 9: {
      const inner = r.u32();
      const count = r.u64();
      if (inner === 8) for (let i = 0; i < count; i++) r.skip(r.u64());
      else if (SIZE[inner]) r.skip(SIZE[inner] * count);
      else for (let i = 0; i < count; i++) value(r, inner);
      return null;
    }
    default: {
      const size = SIZE[type];
      if (!size) throw new Error(`unknown GGUF value type ${type}`);
      r.skip(size);
      return null;
    }
  }
}

/** Reads a GGUF file's header; null when it isn't one. */
export function readGguf(path: string, limit = 256 << 20): GgufInfo | null {
  const fd = openSync(path, "r");
  try {
    const r = new Reader(fd, limit);
    if (r.u32() !== MAGIC) return null;
    r.u32(); // version
    r.u64(); // tensors
    const kvs = r.u64();
    const meta = new Map<string, unknown>();
    for (let i = 0; i < kvs; i++) {
      const key = r.string();
      meta.set(key, value(r, r.u32()));
    }
    const arch =
      typeof meta.get("general.architecture") === "string"
        ? (meta.get("general.architecture") as string)
        : null;
    const num = (k: string) => {
      const v = meta.get(k);
      return typeof v === "number" && v > 0 ? v : null;
    };
    return {
      architecture: arch,
      name:
        typeof meta.get("general.name") === "string" ? (meta.get("general.name") as string) : null,
      contextLength: arch ? num(`${arch}.context_length`) : null,
      layers: arch ? num(`${arch}.block_count`) : null,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A minimal GGUF file with these metadata, for tests (no tensors). */
export function ggufBytes(meta: Record<string, string | number>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const u64 = (v: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(u32(MAGIC), u32(3), u64(0), u64(Object.keys(meta).length + 1));
  // A tokenizer-like array of strings, skipped by the reader.
  parts.push(str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(3), str("a"), str("b"), str("c"));
  for (const [k, v] of Object.entries(meta)) {
    parts.push(str(k));
    if (typeof v === "string") parts.push(u32(8), str(v));
    else parts.push(u32(4), u32(v));
  }
  return Buffer.concat(parts);
}
