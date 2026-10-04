import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { remoteAllowed } from "../auth/lock.ts";
import { CLOUD_ACTIONS } from "../helper/cloud-actions.ts";
import type { HelperDeps } from "../helper/service.ts";
import { rigDaemon } from "../testing/backup-rig.ts";
import { fakeRclone } from "../testing/fake-rclone.ts";
import { decryptConfig, parseIni, rcloneError, writeIni } from "./rclone.ts";
import { CONFIG_PASSWORD, cleanPath, readToken } from "./service.ts";

// Cloud storage without an account (ADR-046): Google Drive's and Dropbox's
// sign-in through rclone's authorize, MEGA's password, with a stand-in
// rclone that prints what the real one would. What Oraknid writes into its
// encrypted config is read back here with the keychain's password.

const closing: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

async function setup(o: Parameters<typeof fakeRclone>[0] = {}) {
  const fake = fakeRclone(o);
  const r = await rigDaemon({ rclone: () => fake.bin });
  closing.push(() => r.daemon.close());
  const config = async () => {
    const pass = r.fake.store.get(CONFIG_PASSWORD) as string;
    return parseIni(
      await decryptConfig(readFileSync(join(r.dir, "cloud", "rclone.conf"), "utf8"), pass),
    );
  };
  const argv = () => {
    try {
      return readFileSync(fake.log, "utf8");
    } catch {
      return "";
    }
  };
  return { ...r, rc: fake, config, argv };
}

const events = (daemon: { db: { $client: { prepare(s: string): { all(): unknown[] } } } }) =>
  JSON.stringify(daemon.db.$client.prepare("select type, payload from events").all());

describe("cloud storage providers through rclone (ADR-046)", () => {
  it("says when rclone is missing, and how to get it", async () => {
    const r = await rigDaemon({ rclone: () => null });
    closing.push(() => r.daemon.close());
    const s = await r.api.cloud.status();
    expect(s.rclone).toMatchObject({ found: false, path: null });
    expect(s.rclone.fix).toMatch(/pacman -S rclone/);
    await expect(
      r.api.cloud.addProvider({
        kind: "mega",
        name: "MEGA",
        email: "me@example.com",
        password: "x",
        folder: "",
      }),
    ).rejects.toThrow(/rclone isn't installed/);
  });

  it("Google Drive: rclone's own sign-in, its address shown, the token kept only in the encrypted config", async () => {
    const { api, daemon, config, argv } = await setup();
    expect((await api.cloud.status()).rclone).toMatchObject({
      found: true,
      version: "rclone v1.75.1-fake",
    });
    const a = await api.cloud.authorizeStart({ kind: "drive" });
    expect(a).toMatchObject({
      kind: "drive",
      url: "http://127.0.0.1:53682/auth?state=fakeState123",
    });
    let s = a;
    for (let i = 0; i < 50 && s.state === "waiting"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = await api.cloud.authorizeStatus({ session: a.session });
    }
    expect(s).toMatchObject({ state: "ready", error: null });
    expect(JSON.stringify(s)).not.toContain("ya29");
    expect(argv()).toMatch(/authorize drive --auth-no-open-browser/);

    const p = await api.cloud.addProvider({
      kind: "drive",
      name: "My Drive",
      authSession: a.session,
      folder: "Oraknid",
    });
    expect(p).toMatchObject({
      kind: "drive",
      name: "My Drive",
      root: "Oraknid",
      detail: "Google Drive · Oraknid/",
      space: "provider",
      freeBytes: 10737418240,
      usedBytes: 5368709120,
      totalBytes: 16106127360,
    });
    const c = await config();
    const section = [...c.values()][0];
    expect(section?.get("type")).toBe("drive");
    expect(section?.get("scope")).toBe("drive");
    expect(JSON.parse(section?.get("token") ?? "{}")).toMatchObject({
      access_token: "ya29.fake-access",
      refresh_token: "1//fake-refresh",
    });
    // The token: in no view, no event, no command line, no row of the database.
    expect(JSON.stringify(await api.cloud.providers())).not.toContain("ya29");
    expect(events(daemon)).not.toContain("ya29");
    expect(argv()).not.toContain("ya29");
    expect(
      JSON.stringify(daemon.db.$client.prepare("select * from cloud_providers").all()),
    ).not.toContain("ya29");
    // The file on disk: encrypted.
    const raw = readFileSync(join(daemon.cloud.configFile()), "utf8");
    expect(raw).toMatch(/^# Encrypted rclone configuration File/);
    expect(raw).not.toContain("drive");
    // A sign-in is used once.
    await expect(
      api.cloud.addProvider({ kind: "drive", name: "Again", authSession: a.session, folder: "" }),
    ).rejects.toThrow(/sign in again/);
  });

  it("Dropbox: a sign-in that hands over more than a token; one that fails says why", async () => {
    const blob = Buffer.from(
      JSON.stringify({
        token: '{"access_token":"sl.fake","token_type":"bearer","expiry":"2030-01-01T00:00:00Z"}',
        team_folder: "abc",
      }),
    ).toString("base64url");
    const { api, config } = await setup({ token: blob });
    const a = await api.cloud.authorizeStart({ kind: "dropbox" });
    let s = a;
    for (let i = 0; i < 50 && s.state === "waiting"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = await api.cloud.authorizeStatus({ session: a.session });
    }
    expect(s.state).toBe("ready");
    const p = await api.cloud.addProvider({
      kind: "dropbox",
      name: "Dropbox",
      authSession: a.session,
      folder: "",
    });
    expect(p.detail).toBe("Dropbox · the whole account");
    const section = (await config()).get(`o-${p.id.toLowerCase()}`);
    expect(section?.get("team_folder")).toBe("abc");
    expect(JSON.parse(section?.get("token") ?? "{}").access_token).toBe("sl.fake");

    const failing = await setup({ authorizeFails: true });
    const f = await failing.api.cloud.authorizeStart({ kind: "dropbox" });
    let fs = f;
    for (let i = 0; i < 50 && fs.state === "waiting"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      fs = await failing.api.cloud.authorizeStatus({ session: f.session });
    }
    expect(fs).toMatchObject({ state: "failed" });
    expect(fs.error).toMatch(/access denied/);
    await expect(
      failing.api.cloud.addProvider({
        kind: "dropbox",
        name: "x",
        authSession: f.session,
        folder: "",
      }),
    ).rejects.toThrow(/hasn't finished/);
  });

  it("MEGA: the password obscured through stdin, never an argument", async () => {
    const { api, daemon, config, argv } = await setup();
    const password = `mega-S3cr3t-${Math.random().toString(36).slice(2)}`;
    const p = await api.cloud.addProvider({
      kind: "mega",
      name: "MEGA",
      email: "me@example.com",
      password,
      folder: "Backups",
    });
    expect(p).toMatchObject({ detail: "MEGA · me@example.com · Backups/", space: "provider" });
    const section = (await config()).get(`o-${p.id.toLowerCase()}`);
    expect(section?.get("user")).toBe("me@example.com");
    expect(section?.get("pass")).toBe(`OBSCURED-${password.length}`);
    expect(argv()).toMatch(/obscure -/);
    expect(argv()).not.toContain(password);
    expect(events(daemon)).not.toContain(password);
    // Renamed, then removed: gone from the config too.
    await api.cloud.updateProvider({ id: p.id, name: "Mega account" });
    expect((await api.cloud.providers())[0]?.name).toBe("Mega account");
    await expect(api.cloud.updateProvider({ id: p.id, limitBytes: 5 })).rejects.toThrow(
      /says its own free space/,
    );
    await api.cloud.removeProvider({ id: p.id });
    expect(await api.cloud.providers()).toEqual([]);
    expect((await config()).size).toBe(0);
  });

  it("adding, changing and removing a provider are home only; reading and the pool are not", () => {
    for (const p of ["addProvider", "updateProvider", "removeProvider", "authorizeStart"])
      expect(remoteAllowed(`/cloud/${p}`)).toBe(false);
    for (const p of ["providers", "list", "search", "move", "deleteFile", "setPlacement"])
      expect(remoteAllowed(`/cloud/${p}`)).toBe(true);
    // A device with full rights may.
    expect(remoteAllowed("/cloud/addProvider", true)).toBe(true);
  });

  it("the helper reads, uploads a file I name (asked first), moves, downloads; deletes are asked; nothing hidden or of Oraknid's is sent", async () => {
    const home = mkdtempSync(join(tmpdir(), "oraknid-helper-cloud-"));
    const dataDir = join(home, "data");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(dataDir);
    writeFileSync(join(home, "report.pdf"), "pdf");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(dataDir, "oraknid.db"), "db");
    const calls: unknown[][] = [];
    const cloud = {
      providers: () => [],
      placement: () => ({ mode: "auto", rule: "free", providerId: null, largeFromBytes: 1 }),
      list: async () => ({ path: "", entries: [], errors: [], truncated: false }),
      search: async () => ({ path: "", entries: [], errors: [], truncated: false }),
      putFile: async (...a: unknown[]) => {
        calls.push(["put", ...a]);
        return { providerId: "P", path: "inbox/report.pdf", size: 3 };
      },
      move: async (...a: unknown[]) => calls.push(["move", ...a]),
      stat: async () => ({ name: "x.txt", isDir: false }),
      getFile: async (_p: string, _path: string, to: string) => {
        writeFileSync(to, "x");
      },
      deleteFile: async (...a: unknown[]) => calls.push(["delete", ...a]),
      label: () => "MinIO",
    };
    const d = { cloud, dataDir } as unknown as HelperDeps;
    const act = CLOUD_ACTIONS;
    expect(act.upload_to_storage?.confirm({} as never)).toBe(true);
    expect(act.delete_from_storage?.confirm({} as never)).toBe(true);
    for (const n of ["storage_list", "storage_search", "move_in_storage", "download_from_storage"])
      expect(act[n]?.confirm({} as never), n).toBe(false);
    const up = await act.upload_to_storage?.run(d, {
      localPath: join(home, "report.pdf"),
      folder: "inbox",
      providerId: null,
    } as never);
    expect(up?.result).toMatch(/Uploaded inbox\/report.pdf .* to MinIO/);
    expect(calls[0]?.[2]).toBe("inbox/report.pdf");
    await expect(
      act.upload_to_storage?.run(d, {
        localPath: join(home, ".ssh", "id_ed25519"),
        folder: "",
        providerId: null,
      } as never) as Promise<unknown>,
    ).rejects.toThrow(/hidden/);
    await expect(
      act.upload_to_storage?.run(d, {
        localPath: join(dataDir, "oraknid.db"),
        folder: "",
        providerId: null,
      } as never) as Promise<unknown>,
    ).rejects.toThrow(/Oraknid's own data folder/);
    // Downloads never replace a file of mine.
    writeFileSync(join(home, "x.txt"), "mine");
    const down = await act.download_from_storage?.run(d, {
      providerId: "P",
      path: "x.txt",
      toFolder: home,
    } as never);
    expect(down?.result).toContain(join(home, "x (1).txt"));
    expect(readFileSync(join(home, "x.txt"), "utf8")).toBe("mine");
  });

  it("paths stay inside the pool; rclone's errors in its own words; tokens read in both shapes", () => {
    expect(cleanPath("/a//b/")).toBe("a/b");
    expect(() => cleanPath("a/../b")).toThrow(/inside the pool/);
    expect(
      rcloneError('{"level":"info","msg":"x"}\n{"level":"error","msg":"Failed to copy: no space"}'),
    ).toBe("no space");
    expect(rcloneError("")).toMatch(/without saying why/);
    expect(readToken('{"access_token":"a"}')).toEqual({ token: '{"access_token":"a"}', extra: {} });
    expect(() => readToken("nonsense")).toThrow(/doesn't understand/);
    const ini = parseIni("[a]\ntype = s3\nkey = v = w\n");
    expect(ini.get("a")?.get("key")).toBe("v = w");
    expect(writeIni(ini)).toBe("[a]\ntype = s3\nkey = v = w\n");
  });
});

// ── Every provider rclone supports (ADR-046 → Changed 2026-10-04)

const step = (
  state: string,
  name: string,
  extra: Record<string, unknown> = {},
): { State: string; Option: Record<string, unknown> } => ({
  State: state,
  Option: {
    Name: name,
    Help: `${name}?`,
    Default: "",
    DefaultStr: "",
    Type: "string",
    Required: false,
    IsPassword: false,
    Sensitive: false,
    Exclusive: false,
    Hide: 0,
    Advanced: false,
    ...extra,
  },
});

/** OneDrive's own setup after the sign-in, as rclone v1.75.1 asks it. */
const ONEDRIVE_SETUP = {
  "|": step("*oauth-confirm,choose_type,,", "config_refresh_token", {
    Type: "bool",
    Default: true,
    DefaultStr: "true",
    Exclusive: true,
    Examples: [
      { Value: "true", Help: "Yes" },
      { Value: "false", Help: "No" },
    ],
  }),
  "*oauth-confirm,choose_type,,|false": step("choose_type_done", "config_type", {
    Help: "Type of connection",
    Default: "onedrive",
    DefaultStr: "onedrive",
    Exclusive: true,
    Examples: [
      { Value: "onedrive", Help: "OneDrive Personal or Business" },
      { Value: "sharepoint", Help: "Root Sharepoint site" },
    ],
  }),
  "choose_type_done|onedrive": step("driveid_final", "config_driveid", {
    Help: "Select drive you want to use",
    Exclusive: true,
    Examples: [{ Value: "b!drive-1", Help: "OneDrive (personal)" }],
  }),
  "driveid_final|b!drive-1": { State: "", Option: null },
};

describe("every provider rclone supports, from its schema", () => {
  it("lists rclone's backends from its own schema, read once per version and kept", async () => {
    const { api, argv, dir } = await setup();
    const list = await api.cloud.backends();
    expect(list.version).toBe("rclone v1.75.1-fake");
    expect(list.backends).toHaveLength(55);
    expect(list.backends.find((b) => b.name === "onedrive")).toMatchObject({
      title: "Microsoft OneDrive",
      oauth: true,
      short: null,
    });
    expect(list.backends[0]).not.toHaveProperty("options");
    const sftp = await api.cloud.backend({ name: "sftp" });
    expect(sftp.options.find((o) => o.name === "pass")).toMatchObject({ password: true });
    await expect(api.cloud.backend({ name: "nope" })).rejects.toThrow(/no backend nope/);
    await api.cloud.backends();
    expect(argv().match(/config providers/g)).toHaveLength(1);
    // Kept beside the config: a daemon started again doesn't ask rclone.
    const kept = readdirSync(join(dir, "cloud")).filter((f) => f.startsWith("backends-"));
    expect(kept).toHaveLength(1);
  });

  it("SFTP from its form: checked against the schema, its password obscured on stdin, never an argument", async () => {
    const { api, daemon, config, argv, rc } = await setup({ about: false });
    await expect(
      api.cloud.addRclone({ name: "Box", backend: "sftp", options: { port: "x" }, folder: "" }),
    ).rejects.toThrow(/Check the form: port: It should be a whole number. host: It's needed./);
    const password = `sftp-S3cr3t-${Math.random().toString(36).slice(2)}`;
    const step1 = await api.cloud.addRclone({
      name: "My server",
      backend: "sftp",
      options: { host: "files.example.org", user: "me", pass: password, port: "2222" },
      folder: "Oraknid",
      limitBytes: 1_000_000,
    });
    expect(step1.question).toBeNull();
    const p = step1.provider;
    expect(p).toMatchObject({
      kind: "rclone",
      backend: "sftp",
      detail: "SSH/SFTP · Oraknid/",
      space: "limit",
      limitBytes: 1_000_000,
      freeBytes: 1_000_000,
    });
    const section = (await config()).get(`o-${p?.id.toLowerCase()}`);
    expect(Object.fromEntries(section ?? [])).toEqual({
      type: "sftp",
      host: "files.example.org",
      user: "me",
      port: "2222",
      pass: `OBSCURED-${password.length}`,
    });
    expect(argv()).toMatch(/config update o-\S+ --non-interactive/);
    expect(argv()).not.toContain(password);
    expect(events(daemon)).not.toContain(password);
    expect(events(daemon)).not.toContain("files.example.org");
    const rows = JSON.stringify(daemon.db.$client.prepare("select * from cloud_providers").all());
    expect(rows).not.toContain(password);
    expect(rows).not.toContain("files.example.org");
    expect(readFileSync(rc.envLog, "utf8")).toContain("continue= state= result=");
    // It can't say its free space: a limit of mine, as for object storage.
    await api.cloud.updateProvider({ id: p?.id as string, unlimited: true });
    expect((await api.cloud.providers())[0]).toMatchObject({ space: "unlimited" });
  });

  it("OneDrive: rclone's sign-in with the form's region, then its own questions, answered in its environment", async () => {
    const blob = Buffer.from(
      JSON.stringify({
        token: '{"access_token":"EwB-fake","token_type":"Bearer","expiry":"2030-01-01T00:00:00Z"}',
        region: "global",
      }),
    )
      .toString("base64")
      .replace(/=+$/, "");
    const { api, daemon, config, argv, rc } = await setup({ token: blob, setup: ONEDRIVE_SETUP });
    // Not before signing in.
    await expect(
      api.cloud.addRclone({ name: "OneDrive", backend: "onedrive", folder: "" }),
    ).rejects.toThrow(/Sign in to Microsoft OneDrive first/);
    await expect(api.cloud.authorizeStart({ kind: "sftp" })).rejects.toThrow(
      /doesn't sign in through a browser/,
    );
    const a = await api.cloud.authorizeStart({
      kind: "onedrive",
      options: { region: "global", tenant: "" },
    });
    expect(a).toMatchObject({ kind: "onedrive", url: expect.stringContaining("127.0.0.1") });
    const sent = /authorize onedrive (\S+) --auth-no-open-browser/.exec(argv())?.[1] ?? "";
    expect(JSON.parse(Buffer.from(sent, "base64").toString("utf8"))).toEqual({ region: "global" });
    let s = a;
    for (let i = 0; i < 50 && s.state === "waiting"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = await api.cloud.authorizeStatus({ session: a.session });
    }
    expect(s.state).toBe("ready");

    const q1 = await api.cloud.addRclone({
      name: "OneDrive",
      backend: "onedrive",
      options: { region: "global" },
      authSession: a.session,
      folder: "Oraknid",
    });
    expect(q1.provider).toBeNull();
    // The token already there is kept without asking; the type of connection is asked.
    expect(q1.question?.option).toMatchObject({
      name: "config_type",
      exclusive: true,
      default: "onedrive",
    });
    await expect(
      api.cloud.answerRclone({ pending: q1.question?.pending as string, answer: "nope" }),
    ).rejects.toThrow(/Pick one of/);
    const q2 = await api.cloud.answerRclone({
      pending: q1.question?.pending as string,
      answer: "onedrive",
    });
    expect(q2.question?.option.examples).toEqual([
      { value: "b!drive-1", help: "OneDrive (personal)", provider: null },
    ]);
    const done = await api.cloud.answerRclone({
      pending: q2.question?.pending as string,
      answer: "b!drive-1",
    });
    expect(done.question).toBeNull();
    expect(done.provider).toMatchObject({
      kind: "rclone",
      backend: "onedrive",
      detail: "Microsoft OneDrive · Oraknid/",
      space: "provider",
      freeBytes: 10737418240,
    });
    const env = readFileSync(rc.envLog, "utf8");
    expect(env).toContain("state=*oauth-confirm,choose_type,, result=false");
    expect(env).toContain("state=choose_type_done result=onedrive");
    expect(env).toContain("state=driveid_final result=b!drive-1");
    expect(argv()).not.toContain("choose_type");
    expect(argv()).not.toContain("b!drive-1");
    const section = (await config()).get(`o-${done.provider?.id.toLowerCase()}`);
    expect(section?.get("type")).toBe("onedrive");
    expect(section?.get("region")).toBe("global");
    expect(JSON.parse(section?.get("token") ?? "{}").access_token).toBe("EwB-fake");
    for (const where of [
      argv(),
      events(daemon),
      JSON.stringify(await api.cloud.providers()),
      JSON.stringify(daemon.db.$client.prepare("select * from cloud_providers").all()),
    ])
      expect(where).not.toContain("EwB-fake");
    // A finished add can't be answered again.
    await expect(
      api.cloud.answerRclone({ pending: q2.question?.pending as string, answer: "x" }),
    ).rejects.toThrow(/isn't waiting/);
  });

  it("a code rclone asks for passes in its environment, and is said nowhere; a setup that fails leaves nothing", async () => {
    const code = "842913";
    const { api, daemon, config, argv, rc } = await setup({
      setup: {
        "|": step("2fa_do", "config_2fa", {
          Help: "Two-factor authentication: please enter your 2FA code",
          Sensitive: true,
          IsPassword: true,
          Required: true,
        }),
        "2fa_do|000000": {
          ...step("2fa_do", "config_2fa", { IsPassword: true, Required: true }),
          Error: "wrong code 000000",
        },
        [`2fa_do|${code}`]: { State: "", Option: null },
      },
    });
    const password = `apple-S3cr3t-${Math.random().toString(36).slice(2)}`;
    const q = await api.cloud.addRclone({
      name: "iCloud",
      backend: "iclouddrive",
      options: { apple_id: "me@example.com", password },
      folder: "",
    });
    expect(q.question?.option).toMatchObject({ name: "config_2fa", secret: true });
    const again = await api.cloud.answerRclone({
      pending: q.question?.pending as string,
      answer: "000000",
    });
    expect(again.question?.error).toBe("wrong code •••");
    const done = await api.cloud.answerRclone({
      pending: q.question?.pending as string,
      answer: code,
    });
    expect(done.provider?.detail).toBe("iCloud Drive and Photos · the whole account");
    expect(readFileSync(rc.envLog, "utf8")).toContain(`result=${code}`);
    for (const s of [code, password]) {
      expect(argv()).not.toContain(s);
      expect(events(daemon)).not.toContain(s);
    }
    expect(
      Object.fromEntries((await config()).get(`o-${done.provider?.id.toLowerCase()}`) ?? []),
    ).toMatchObject({ type: "iclouddrive", apple_id: "me@example.com" });

    // rclone says it can't go on: refused, its section gone.
    const failing = await setup({
      setup: { "|": { State: "", Option: null, Error: `login refused for ${password}` } },
    });
    await expect(
      failing.api.cloud.addRclone({
        name: "x",
        backend: "iclouddrive",
        options: { apple_id: "me@example.com", password },
        folder: "",
      }),
    ).rejects.toThrow(/iCloud Drive and Photos didn't answer: login refused for •••/);
    expect((await failing.config()).size).toBe(0);
    expect(await failing.api.cloud.providers()).toEqual([]);

    // One given up is gone from the config too.
    const asking = await setup({ setup: { "|": step("x", "config_any") } });
    const w = await asking.api.cloud.addRclone({
      name: "x",
      backend: "pikpak",
      options: { user: "me", pass: "pw-123456" },
      folder: "",
    });
    expect((await asking.config()).size).toBe(1);
    await asking.api.cloud.cancelRclone({ pending: w.question?.pending as string });
    expect((await asking.config()).size).toBe(0);
  });

  it("adding one of any backend, and answering rclone, are home only; the list of backends is not", () => {
    for (const p of ["addRclone", "answerRclone"]) expect(remoteAllowed(`/cloud/${p}`)).toBe(false);
    for (const p of ["backends", "backend", "cancelRclone"])
      expect(remoteAllowed(`/cloud/${p}`)).toBe(true);
  });
});
