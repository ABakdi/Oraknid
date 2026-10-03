import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Remote images in mail, once I allow them (ADR-032): the daemon fetches
// them and the message's frame gets them inline, so the UI itself never
// loads anything from outside (its content policy stays closed; Audit 2).
// The sender still sees a fetch, from my computer, as with any client.

const MAX_IMAGES = 40;
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** The remote images a mail's HTML names: src, background, CSS url(). */
export function remoteImages(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\b(?:src|background|poster)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi))
    found.add(decode(m[1] as string));
  for (const m of html.matchAll(/url\(\s*["']?(https?:\/\/[^"')\s]+)/gi))
    found.add(decode(m[1] as string));
  return [...found].slice(0, MAX_IMAGES);
}

const decode = (s: string) => s.replaceAll("&amp;", "&");

/** A host on the public internet: never this computer or my network (no request forgery from mail). */
async function publicHost(host: string): Promise<boolean> {
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((a) => !isPrivate(a.address));
}

export function isPrivate(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
}

/** Each allowed image as a data: URL; what can't be fetched safely is left out. */
export async function fetchImages(urls: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    urls.slice(0, MAX_IMAGES).map(async (raw) => {
      try {
        let url = new URL(raw);
        // Redirects are followed by hand, each hop checked.
        for (let hop = 0; hop < 4; hop++) {
          if (!/^https?:$/.test(url.protocol) || !(await publicHost(url.hostname))) return;
          const res = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { accept: "image/*" },
          });
          if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            url = new URL(res.headers.get("location") as string, url);
            continue;
          }
          const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
          if (
            !res.ok ||
            !/^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(type)
          )
            return;
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length > MAX_BYTES) return;
          out[raw] = `data:${type};base64,${body.toString("base64")}`;
          return;
        }
      } catch {}
    }),
  );
  return out;
}
