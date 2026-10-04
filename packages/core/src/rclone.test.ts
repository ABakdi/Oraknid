import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RcloneBackend, RcloneOption } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { choosePlace } from "./cloud.ts";
import {
  checkOptions,
  configValue,
  formModel,
  formOptions,
  matchesProvider,
  readRcloneSchema,
  searchBackends,
  summaryOf,
} from "./rclone.ts";

// rclone's schema (ADR-046 → Changed 2026-10-04), read from what the real
// rclone v1.75.1 printed for `rclone config providers` (recorded, its
// help pages left out and this machine's user name made "me").

const recorded = (): unknown =>
  JSON.parse(
    gunzipSync(
      readFileSync(join(__dirname, "fixtures", "rclone-providers-v1.75.1.json.gz")),
    ).toString("utf8"),
  );

const all = readRcloneSchema(recorded());
const get = (name: string) => all.find((b) => b.name === name) as RcloneBackend;

describe("rclone's providers, from its own schema", () => {
  it("offers every place of its own, not the wrappers, this computer or the read-only ones", () => {
    const names = all.map((b) => b.name);
    expect(names.length).toBe(55);
    for (const n of ["sftp", "webdav", "onedrive", "pcloud", "box", "b2", "protondrive", "s3"])
      expect(names).toContain(n);
    for (const n of ["iclouddrive", "ftp", "smb", "azureblob", "google cloud storage", "zoho"])
      expect(names).toContain(n);
    for (const n of ["alias", "crypt", "union", "local", "memory", "http", "doi", "tardigrade"])
      expect(names).not.toContain(n);
    // Short titles, in order.
    expect(get("s3").title).toBe("Amazon S3 Compliant Storage Providers");
    expect(get("seafile").title).toBe("Seafile");
    expect([...names].sort((a, b) => get(a).title.localeCompare(get(b).title))).toEqual(names);
    // Google Drive, Dropbox and MEGA keep their short forms.
    expect(["drive", "dropbox", "mega"].map((n) => get(n).short)).toEqual([
      "drive",
      "dropbox",
      "mega",
    ]);
    expect(get("sftp").short).toBeNull();
  });

  it("knows which sign in through a browser, and keeps rclone's own app out of their forms", () => {
    const oauth = all.filter((b) => b.oauth).map((b) => b.name);
    expect(oauth.sort()).toEqual([
      "box",
      "drive",
      "dropbox",
      "google cloud storage",
      "google photos",
      "hidrive",
      "huaweidrive",
      "onedrive",
      "pcloud",
      "premiumizeme",
      "putio",
      "sharefile",
      "yandex",
      "zoho",
    ]);
    // Mail.ru and Jottacloud have a token too, but rclone gets it another way.
    expect(get("mailru").oauth).toBe(false);
    expect(get("jottacloud").oauth).toBe(false);
    const od = get("onedrive").options.map((o) => o.name);
    for (const n of ["token", "client_id", "client_secret", "auth_url", "token_url"])
      expect(od).not.toContain(n);
    // A token that is the account's own key stays a field (Linkbox).
    expect(get("linkbox").options.find((o) => o.name === "token")).toMatchObject({
      secret: true,
      required: true,
    });
  });

  it("leaves hidden options out; passwords and keys are secrets, addresses and names are not", () => {
    const sftp = get("sftp");
    const opt = (n: string) => sftp.options.find((o) => o.name === n);
    expect(opt("pass")).toMatchObject({ password: true, secret: true, type: "string" });
    expect(opt("key_pem")).toMatchObject({ secret: true, password: false });
    expect(opt("key_file_pass")).toMatchObject({ password: true, secret: true });
    expect(opt("host")).toMatchObject({ secret: false, required: true });
    expect(opt("port")).toMatchObject({ type: "int", default: "22" });
    const raw = (recorded() as { Name: string; Options: { Name: string; Hide: number }[] }[]).find(
      (b) => b.Name === "sftp",
    );
    const hidden = raw?.Options.filter((o) => o.Hide !== 0).map((o) => o.Name) ?? [];
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) expect(opt(h)).toBeUndefined();
    const s3 = get("s3");
    expect(s3.options.find((o) => o.name === "secret_access_key")?.secret).toBe(true);
    expect(s3.options.find((o) => o.name === "access_key_id")?.secret).toBe(false);
    expect(get("b2").options.find((o) => o.name === "key")?.secret).toBe(true);
    expect(get("webdav").options.find((o) => o.name === "url")?.secret).toBe(false);
    // The list sent first has no options.
    expect(summaryOf(sftp)).not.toHaveProperty("options");
  });

  it("finds a backend by its name, title or another name", () => {
    expect(searchBackends(all, "onedrive")[0]?.name).toBe("onedrive");
    expect(searchBackends(all, "One")[0]?.name).toBe("onedrive");
    expect(searchBackends(all, "ssh").map((b) => b.name)).toEqual(["sftp"]);
    expect(searchBackends(all, "tardigrade").map((b) => b.name)).toEqual(["storj"]);
    expect(searchBackends(all, "hetzner").map((b) => b.name)).toContain("s3");
    expect(searchBackends(all, "google").map((b) => b.name)).toEqual(
      expect.arrayContaining(["drive", "google photos", "google cloud storage"]),
    );
    expect(searchBackends(all, "nothing-like-it")).toEqual([]);
    expect(searchBackends(all, "  ")).toHaveLength(all.length);
  });
});

describe("the form made from a backend", () => {
  it("SFTP: required first, the everyday options, the rest under Advanced, each typed", () => {
    const m = formModel(get("sftp"));
    expect(m.provider).toBeNull();
    expect(m.required.map((o) => o.name)).toEqual(["host"]);
    expect(m.basic.map((o) => o.name)).toEqual(
      expect.arrayContaining(["user", "port", "pass", "key_file", "key_use_agent"]),
    );
    expect(m.advanced.map((o) => o.name)).toEqual(
      expect.arrayContaining(["known_hosts_file", "set_modtime", "chunk_size", "idle_timeout"]),
    );
    const input = (n: string) => formOptions(m).find((o) => o.name === n)?.input;
    expect(input("pass")).toBe("password");
    expect(input("key_pem")).toBe("multiline");
    expect(input("port")).toBe("int");
    expect(input("key_use_agent")).toBe("bool");
    expect(input("chunk_size")).toBe("size");
    expect(input("idle_timeout")).toBe("duration");
    // Every option once.
    const names = formOptions(m).map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("S3: the service first; only its options and choices once picked", () => {
    const s3 = get("s3");
    const before = formModel(s3);
    expect(before.provider?.examples.length).toBe(53);
    expect(before.provider?.input).toBe("choice");
    expect(formOptions(before).map((o) => o.name)).not.toContain("endpoint");

    const aws = formModel(s3, { provider: "AWS" });
    const names = formOptions(aws).map((o) => o.name);
    expect(names).toContain("region");
    expect(names).toContain("requester_pays");
    const region = formOptions(aws).find((o) => o.name === "region");
    expect(region?.examples.every((e) => matchesProvider(e.provider, "AWS"))).toBe(true);
    expect(region?.examples.map((e) => e.value)).toContain("eu-west-1");

    const minio = formModel(s3, { provider: "Minio" });
    const mnames = formOptions(minio).map((o) => o.name);
    expect(mnames).toContain("endpoint");
    expect(mnames).not.toContain("requester_pays");
    // Cloudflare's own endpoints aren't offered for Hetzner.
    const hz = formOptions(formModel(s3, { provider: "Hetzner" })).find(
      (o) => o.name === "endpoint",
    );
    expect(hz?.examples.length).toBeGreaterThan(0);
    expect(hz?.examples.every((e) => /hetzner|your-objectstorage/i.test(e.value))).toBe(true);
  });

  it("Koofr: one password field whichever service, its help that service's", () => {
    const k = get("koofr");
    const m = formModel(k, { provider: "digistorage" });
    const pw = formOptions(m).filter((o) => o.name === "password");
    expect(pw).toHaveLength(1);
    expect(pw[0]).toMatchObject({ provider: "digistorage", input: "password" });
    expect(m.required.map((o) => o.name)).toEqual(["user", "password"]);
    // "other" asks for its endpoint too.
    expect(formModel(k, { provider: "other" }).required.map((o) => o.name)).toContain("endpoint");
  });

  it("checks what the form gives: required, types, choices, unknown options, line breaks", () => {
    const sftp = get("sftp");
    expect(checkOptions(sftp, {}).errors).toEqual({ host: "It's needed." });
    const bad = checkOptions(sftp, {
      host: "example.org",
      port: "twenty",
      key_use_agent: "yes",
      chunk_size: "lots",
      idle_timeout: "soon",
      nope: "x",
      user: "a\nb",
    });
    expect(bad.errors).toMatchObject({
      port: "It should be a whole number.",
      key_use_agent: "It should be true or false.",
      chunk_size: expect.stringMatching(/a size/),
      idle_timeout: expect.stringMatching(/a duration/),
      nope: "SSH/SFTP has no option nope.",
      user: "It can't hold a line break.",
    });
    const good = checkOptions(sftp, {
      host: " example.org ",
      port: "2222",
      chunk_size: "64Ki",
      idle_timeout: "1h30m",
      key_use_agent: "false",
      user: "",
    });
    expect(good).toEqual({
      values: {
        host: "example.org",
        port: "2222",
        chunk_size: "64Ki",
        idle_timeout: "1h30m",
        key_use_agent: "false",
      },
      errors: {},
    });
    // A PEM key's lines as rclone keeps them.
    const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
    expect(configValue({ ...(sftp.options[0] as RcloneOption), name: "key_pem" }, pem)).toBe(
      "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    );

    const s3 = get("s3");
    expect(checkOptions(s3, {}).errors.provider).toBe("Say which service it is.");
    expect(checkOptions(s3, { provider: "Nope" }).errors.provider).toMatch(/one of: AWS, /);
    // An option of another service isn't taken.
    expect(checkOptions(s3, { provider: "Minio", requester_pays: "true" }).errors).toEqual({
      requester_pays: "requester_pays isn't one for this service.",
    });
  });
});

describe("placement with providers of any backend", () => {
  it("by size, object storage is the one rclone says keeps buckets", () => {
    const placed = choosePlace(
      [
        { id: "a", name: "SFTP", kind: "rclone", free: 10e9, priority: 0, object: false },
        { id: "b", name: "B2", kind: "rclone", free: 5e9, priority: 1, object: true },
      ],
      500e6,
      { mode: "auto", rule: "size", providerId: null, largeFromBytes: 100e6 },
    );
    expect(placed).toEqual({ ok: true, id: "b" });
  });
});
