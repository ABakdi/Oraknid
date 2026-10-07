import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// A small zip writer and reader for Oraknid's own exports (ADR-061): files
// deflated (or stored when that is smaller), no zip64, no encryption. The
// reader takes only what the writer makes: plain relative names, no `..`,
// sizes checked, and a limit on what it inflates.

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Most a zip of ours may hold once inflated (ADR-061). */
export const MAX_UNZIPPED = 500 * 1024 * 1024;

/** A file name a zip of ours may hold: relative, forward slashes, no `.` or `..` parts. */
export function safeName(name: string): boolean {
  if (!name || name.length > 512 || name.startsWith("/") || name.includes("\\")) return false;
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) return false;
  return name.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

/** DOS time and date of a moment, as zip keeps them. */
function dos(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date:
      ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

export function zip(entries: ZipEntry[], at = new Date()): Buffer {
  const { time, date } = dos(at);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!safeName(e.name)) throw new Error(`Not a file name a zip can hold: ${e.name}`);
    if (seen.has(e.name)) throw new Error(`Twice in one zip: ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const deflated = deflateRawSync(e.data);
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const crc = crc32(e.data);
    if (offset > 0xffffffff || e.data.length > 0xffffffff)
      throw new Error("Too big for a zip of Oraknid's.");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4); // made by Unix, 3.0
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((0o100600 << 16) >>> 0, 38); // a regular file, mine only
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const damaged = (why: string) => new Error(`That isn't a zip Oraknid can read: ${why}.`);

/** The files of a zip, by name; refused when it isn't one of ours or holds too much. */
export function unzip(buf: Buffer, max = MAX_UNZIPPED): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw damaged("no end of its directory");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (p + cdSize > eocd) throw damaged("its directory is out of place");
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw damaged("a bad entry");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue; // a folder
    if (!safeName(name)) throw damaged(`a file outside its folders (${name})`);
    total += usize;
    if (total > max) throw new Error("That zip holds too much to import (500 MB at most).");
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw damaged("a bad file");
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const body = buf.subarray(start, start + csize);
    if (body.length !== csize) throw damaged("a file cut short");
    const data =
      method === 0
        ? Buffer.from(body)
        : method === 8
          ? inflateRawSync(body, { maxOutputLength: Math.max(1, usize) })
          : null;
    if (!data) throw damaged(`a file packed in a way it doesn't know (${method})`);
    if (data.length !== usize || crc32(data) !== crc) throw damaged(`${name} is damaged`);
    out.set(name, data);
  }
  return out;
}
