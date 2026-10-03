import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MONITOR_SCRIPT } from "./monitor.ts";

// oraknid-monitor's parts (ADR-043), run for real under `sh` with stand-in
// docker, systemctl, ss, nginx, openssl, journalctl… on the PATH, printing
// what the real ones print (taken from a real Debian server), and the
// server's files under a root of their own (ORAKNID_MONITOR_ROOT).

const T = "\t";
let dir: string;
let bin: string;
let root: string;
let script: string;

const fake = (name: string, body: string) => {
  const f = join(bin, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
};
const file = (path: string, body: string) => {
  const f = join(root, path);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
  return f;
};

/** nginx's time format, in UTC (the script runs with TZ=UTC). */
const clf = (d: Date) => {
  const mon = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("/bin/sh", [script, ...args], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TZ: "UTC",
      ORAKNID_MONITOR_ROOT: root,
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (args: string[], env?: Record<string, string>) => {
  const r = run(args, env);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`Not JSON (exit ${r.code}):\n${r.out}\n${r.err}`);
  }
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oraknid-monitor-"));
  bin = join(dir, "bin");
  root = join(dir, "root");
  mkdirSync(bin);
  mkdirSync(root);
  script = join(dir, "oraknid-monitor");
  writeFileSync(script, MONITOR_SCRIPT);

  // docker, as Docker 27 prints it (the format asked for is tab separated).
  const ps = [
    [
      "dd022a43abe4",
      "harvest-server-1",
      "harvest-server:0937e74",
      "running",
      "Up 3 days (healthy)",
      "127.0.0.1:8080->8080/tcp",
      "harvest",
      "server",
    ],
    [
      "a1b2c3d4e5f6",
      "harvest-mongo-1",
      "mongo:4.4",
      "running",
      "Up 5 days (healthy)",
      "",
      "harvest",
      "mongo",
    ],
    [
      "0a0b0c0d0e0f",
      "misahaty-app",
      "misahaty_app",
      "running",
      "Up 4 weeks (unhealthy)",
      "0.0.0.0:3456->3456/tcp, :::3456->3456/tcp",
      "misahaty",
      "app",
    ],
    ["111111111111", "pg", "postgres:16-alpine", "exited", "Exited (0) 2 days ago", "", "", ""],
    [
      "222222222222",
      "proxy",
      "traefik:v3.1",
      "running",
      "Up 1 hour",
      "0.0.0.0:443->443/tcp",
      "",
      "",
    ],
    ["333333333333", 'weird "name"', "busybox", "created", "Created", "", "<no value>", ""],
  ]
    .map((r) => r.join(T))
    .join("\n");
  fake(
    "docker",
    `[ -n "\${FAKE_DOCKER_DENIED:-}" ] && { echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2; exit 1; }
case "$1 $2" in
  "version --format") echo 27.0.3 ;;
  "ps -aq") echo dd022a43abe4; echo a1b2c3d4e5f6 ;;
  "ps -q") echo dd022a43abe4; echo 222222222222 ;;
  "ps -a")
    if [ "$3" = --no-trunc ]; then printf '%s\\n' "harvest_db,/srv/x" "" "pgdata"
    else cat <<'EOF'
${ps}
EOF
    fi ;;
  "stats --no-stream") printf 'harvest-server-1\\t0.08%%\\t85.22MiB / 3.828GiB\\nharvest-mongo-1\\t12.5%%\\t1.2GiB / 3.828GiB\\n' ;;
  "inspect --format")
    case "$3" in
      *Labels*) printf '/proxy\\ntraefik.enable=true\\n/harvest-server-1\\ntraefik.http.routers.h.rule=Host(\\140harvest.example.com\\140) || Host(\\140www.example.com\\140)\\ntraefik.http.services.h.loadbalancer.server.port=8080\\n' ;;
      *) echo sha256:960894ad3505a7359792651104ea7bee7dd7d2940f86d402ffc5a3c798ee967d; echo sha256:aaaaaaaaaaaa0000 ;;
    esac ;;
  "images --format") printf 'harvest-server\\t0937e74\\t960894ad3505\\t189MB\\t3 days ago\\n<none>\\t<none>\\t2f578529073e\\t231MB\\t11 hours ago\\nmongo\\t4.4\\taaaaaaaaaaaa\\t1.2GB\\t2 months ago\\n' ;;
  "volume ls") printf 'harvest_db\\tlocal\\tharvest\\n80da68ffc477\\tlocal\\t\\n' ;;
  "network ls") printf 'bridge\\tbridge\\tlocal\\nharvest_default\\tbridge\\tlocal\\n' ;;
  "logs --timestamps")
    case " $* " in
      *" -f "*) i=0; while :; do i=$((i+1)); echo "2026-10-03T18:00:0$i line $i"; sleep 0.1; done ;;
      *) printf '2026-10-03T18:00:00Z started\\n2026-10-03T18:00:01Z \\033[32mGET /v1/health 200\\033[0m\\n2026-10-03T18:00:02Z error: mongo timeout\\n' ;;
    esac ;;
  *) echo "fake docker: $*" >&2; exit 1 ;;
esac`,
  );
  fake(
    "systemctl",
    `case "$*" in
  *"--all"*) printf '%s\\n' "postgresql.service loaded active exited PostgreSQL RDBMS" "postgresql@15-main.service loaded active running PostgreSQL Cluster 15-main" "redis-server.service loaded failed failed Advanced key-value store" "nginx.service loaded active running A high performance web server" "ssh.service loaded active running OpenBSD Secure Shell server" ;;
  *"--state=running"*) printf '%s\\n' "nginx.service loaded active running nginx" "ssh.service loaded active running ssh" ;;
  "is-active nginx") echo active ;;
  "is-active "*) echo inactive; exit 3 ;;
esac`,
  );
  fake(
    "ss",
    `case "$*" in
  *-tlnH*) printf '%s\\n' "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*" "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*" "LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*" "LISTEN 0 511 [::]:443 [::]:*" ;;
  *established*) printf '%s\\n' "0 0 95.217.201.11:443 105.99.110.39:40718" "0 0 95.217.201.11:443 109.160.32.163:58094" "0 0 [::ffff:95.217.201.11]:80 [::ffff:1.2.3.4]:5555" "0 0 127.0.0.1:54810 127.0.0.1:8787" ;;
esac`,
  );
  fake("pgrep", "exit 1");
  fake("psql", 'echo "psql (PostgreSQL) 15.4 (Debian 15.4-1.pgdg120+1)"');
  fake("redis-server", 'echo "Redis server v=7.0.11 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64"');
  fake("sudo", '[ "$1" = -n ] && shift; [ "$1" = true ] && exit 0; exec "$@"');
  fake(
    "nginx",
    `case "$1" in
  -T) cat "$ORAKNID_MONITOR_ROOT/nginx-T.txt" ;;
  -v) echo "nginx version: nginx/1.18.0" >&2 ;;
  -t) echo "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok" >&2; echo "nginx: configuration file /etc/nginx/nginx.conf test is successful" >&2 ;;
esac`,
  );
  fake(
    "openssl",
    `for a; do p=$a; done; case "$p" in *expired*) echo "notAfter=Jan  1 00:00:00 2020 GMT" ;; *) echo "notAfter=Dec 30 12:00:00 2026 GMT" ;; esac`,
  );
  fake(
    "journalctl",
    `case " $* " in
  *" -f "*) i=0; while :; do i=$((i+1)); echo "2026-10-03T18:00:00+0000 host nginx[1]: tick $i"; sleep 0.1; done ;;
  *) printf '%s\\n' "2026-10-03T18:00:00+0000 host systemd[1]: Started nginx." "2026-10-03T18:00:01+0000 host nginx[1]: worker up" "2026-10-03T18:00:02+0000 host nginx[1]: ERROR upstream timed out" ;;
esac`,
  );

  // nginx -T, as a real one prints it: an upstream, a redirect, a TLS site, a static site.
  file(
    "nginx-T.txt",
    `# configuration file /etc/nginx/nginx.conf:
http {
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;
    include /etc/nginx/sites-enabled/*;
    upstream app_backend {
        server 127.0.0.1:3000;
        server 127.0.0.1:3001 backup;
    }
# configuration file /etc/nginx/sites-enabled/harvest:
log_format harvest_noip '[$time_iso8601] "$request_method $uri" $status $body_bytes_sent $request_time';
server {
    listen 80;
    listen [::]:80;
    server_name harvest.abakdi.com;
    location / { return 301 https://harvest.abakdi.com$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name harvest.abakdi.com; # the app
    access_log /var/log/nginx/harvest.access.log harvest_noip;
    ssl_certificate /etc/letsencrypt/live/harvest.abakdi.com/fullchain.pem;
    root /var/www/harvest/current;
    location /v1/ { proxy_pass http://127.0.0.1:8080; }
}
server {
    listen 443 ssl;
    server_name api.example.com www.api.example.com;
    ssl_certificate ${root}/etc/ssl/expired.pem;
    location / { proxy_pass http://app_backend/; }
}
}
`,
  );
  file("etc/ssl/expired.pem", "-----BEGIN CERTIFICATE-----\n");
  file("var/lib/postgresql/15/main/base", "x".repeat(4096));

  // Access logs: the combined format, and one of harvest's own with no client.
  const now = Date.now();
  const at = (minAgo: number) => clf(new Date(now - minAgo * 60_000));
  const combined = [
    `80.94.92.65 - - [${at(40)}] "GET /old HTTP/1.1" 200 10 "-" "x"`,
    `80.94.92.65 - - [${at(2)}] "GET /.env HTTP/1.1" 404 143 "-" "Wget/1.9.1"`,
    `142.147.225.152 - - [${at(1)}] "GET / HTTP/2.0" 200 8173 "-" "Mozilla/5.0"`,
    `142.147.225.152 - - [${at(1)}] "GET /?q=secret HTTP/2.0" 200 100 "-" "Mozilla/5.0"`,
    `105.99.110.39 - - [${at(0)}] "GET /daemon?id=d-163 HTTP/1.1" 101 252 "-" "-"`,
    `105.99.110.39 - - [${at(0)}] "POST /api/x HTTP/1.1" 502 0 "-" "-"`,
    "garbage line",
  ];
  file("var/log/nginx/access.log", `${combined.join("\n")}\n`);
  const iso = new Date(now - 60_000).toISOString().slice(0, 19);
  file("var/log/nginx/harvest.access.log", `[${iso}+00:00] "GET /v1/sync" 200 512 0.004\n`);
  file("var/log/nginx/error.log", "");
  const locked = file("var/log/nginx/locked.access.log", "x\n");
  chmodSync(locked, 0o000);
});

describe("oraknid-monitor's parts (ADR-043)", () => {
  it("keeps the 15 s reading as it was, and says its version", () => {
    expect(run(["version"]).out.trim()).toBe("2");
    const s = json(["sample"]);
    expect(s.memTotal).toBeGreaterThan(0);
    expect(s.services).toEqual(["nginx.service", "ssh.service"]);
    expect(s.ports).toContain("0.0.0.0:443");
    expect(run(["nope"]).code).toBe(2);
  });

  it("reads Docker: containers with health, uptime, CPU and memory, images in use, volumes, networks", () => {
    const d = json(["sample", "docker"]);
    expect(d).toMatchObject({ engine: "docker", version: "27.0.3", error: null });
    const [server, mongo, app, pg] = d.containers;
    expect(server).toMatchObject({
      name: "harvest-server-1",
      state: "running",
      health: "healthy",
      uptime: "3 days",
      project: "harvest",
      service: "server",
      cpuPercent: 0.08,
      memBytes: 89359647,
      memLimit: 4110283702,
    });
    expect(mongo).toMatchObject({ memBytes: 1288490189, cpuPercent: 12.5 });
    expect(app).toMatchObject({ health: "unhealthy", uptime: "4 weeks", project: "misahaty" });
    expect(pg).toMatchObject({ state: "exited", uptime: null, cpuPercent: null, project: null });
    // A name with quotes stays JSON; "<no value>" is no project.
    expect(d.containers[5]).toMatchObject({ name: 'weird "name"', project: null });
    expect(d.images).toEqual([
      expect.objectContaining({
        repository: "harvest-server",
        id: "960894ad3505",
        sizeBytes: 189000000,
        inUse: true,
      }),
      expect.objectContaining({ repository: "<none>", inUse: false }),
      expect.objectContaining({ repository: "mongo", sizeBytes: 1200000000, inUse: true }),
    ]);
    expect(d.volumes).toEqual([
      { name: "harvest_db", driver: "local", project: "harvest", inUse: true },
      { name: "80da68ffc477", driver: "local", project: null, inUse: false },
    ]);
    expect(d.networks.map((n: { name: string }) => n.name)).toEqual(["bridge", "harvest_default"]);
  });

  it("says why Docker can't be read instead of asking for root", () => {
    const d = json(["sample", "docker"], { FAKE_DOCKER_DENIED: "1" });
    expect(d.engine).toBe("docker");
    expect(d.error).toMatch(/add .+ to the docker group/);
    expect(d.containers).toEqual([]);
    // The databases and the proxy say it too, and still read the rest.
    const db = json(["sample", "databases"], { FAKE_DOCKER_DENIED: "1" });
    expect(db.notes[0]).toMatch(/Containers not read: .+docker group/);
    expect(db.databases.length).toBeGreaterThan(0);
  });

  it("finds databases as services and containers, with their version, port and size when readable", () => {
    const d = json(["sample", "databases"]);
    const byName = Object.fromEntries(d.databases.map((x: { name: string }) => [x.name, x]));
    // Debian's postgresql.service only starts its clusters: the cluster is the one shown.
    expect(byName["postgresql.service"]).toBeUndefined();
    expect(byName["postgresql@15-main.service"]).toMatchObject({
      kind: "postgres",
      source: "service",
      version: "15.4",
      state: "active",
      port: 5432,
    });
    expect(Number(byName["postgresql@15-main.service"].sizeBytes)).toBeGreaterThan(0);
    expect(byName["redis-server.service"]).toMatchObject({
      kind: "redis",
      version: "7.0.11",
      state: "failed",
      port: null,
      sizeBytes: null,
    });
    expect(byName["redis-server.service"].note).toMatch(/No data folder/);
    expect(byName["harvest-mongo-1"]).toMatchObject({
      kind: "mongodb",
      source: "container",
      version: "4.4",
    });
    expect(byName.pg).toMatchObject({ kind: "postgres", version: "16-alpine", state: "exited" });
  });

  it("reads nginx's sites, upstreams, certificates and logs, its check, and Traefik's routes", () => {
    const p = json(["sample", "proxy"]);
    const nginx = p.proxies.find((x: { kind: string }) => x.kind === "nginx");
    expect(nginx).toMatchObject({ source: "service", state: "active", version: "1.18.0" });
    expect(nginx.check).toEqual({
      ok: true,
      output: expect.stringContaining("test is successful"),
    });
    expect(nginx.sites).toEqual([
      expect.objectContaining({
        names: ["harvest.abakdi.com"],
        listen: ["80", "[::]:80"],
        redirect: "301 https://harvest.abakdi.com$request_uri",
      }),
      expect.objectContaining({
        names: ["harvest.abakdi.com"],
        upstreams: ["127.0.0.1:8080"],
        root: "/var/www/harvest/current",
        certificate: "/etc/letsencrypt/live/harvest.abakdi.com/fullchain.pem",
        accessLog: "/var/log/nginx/harvest.access.log",
      }),
      expect.objectContaining({
        names: ["api.example.com", "www.api.example.com"],
        upstreams: ["127.0.0.1:3000", "127.0.0.1:3001"],
      }),
    ]);
    const certs = Object.fromEntries(nginx.certificates.map((c: { path: string }) => [c.path, c]));
    expect(certs[`${root}/etc/ssl/expired.pem`]).toMatchObject({
      notAfter: "Jan  1 00:00:00 2020 GMT",
      error: null,
    });
    expect(certs["/etc/letsencrypt/live/harvest.abakdi.com/fullchain.pem"].error).toMatch(
      /not there|not readable/,
    );
    // Only logs that are there (the configured ones are absolute paths on the real server).
    expect(nginx.accessLogs).toEqual([`${root}/var/log/nginx/access.log`]);
    const traefik = p.proxies.find((x: { kind: string }) => x.kind === "traefik");
    expect(traefik).toMatchObject({ source: "container", name: "proxy", state: "running" });
    expect(traefik.sites).toEqual([
      expect.objectContaining({
        names: ["harvest.example.com", "www.example.com"],
        upstreams: ["harvest-server-1:8080"],
      }),
    ]);
  });

  it("counts the last minutes of traffic from the access logs, and connections per port", () => {
    const t = json(["sample", "traffic"]);
    expect(t.windowMinutes).toBe(15);
    // The 40-minute-old line is out of the window; the garbage line is unparsed.
    expect(t.requests).toBe(6);
    expect(t.unparsed).toBe(1);
    expect(t.perMinute).toHaveLength(15);
    expect(t.perMinute.reduce((a: number, b: number) => a + b, 0)).toBe(6);
    expect(t.statuses).toEqual({ "2xx": 3, "3xx": 0, "4xx": 1, "5xx": 1 });
    expect(t.bytes).toBe(143 + 8173 + 100 + 252 + 512);
    // Paths without their query strings.
    expect(t.paths[0]).toEqual({ path: "/", count: 2 });
    expect(t.paths.map((x: { path: string }) => x.path)).not.toContain("/?q=secret");
    expect(t.clients).toEqual(expect.arrayContaining([{ client: "142.147.225.152", count: 2 }]));
    expect(t.connections).toEqual([
      { port: "443", count: 2 },
      { port: "80", count: 1 },
    ]);
    const locked = t.logs.find((l: { path: string }) => l.path.endsWith("locked.access.log"));
    if (process.getuid?.() !== 0) expect(locked.error).toMatch(/not readable/);
  });

  it("prints a log's last lines, a search in it, and refuses what isn't a log", () => {
    const unit = run(["logs", "unit:nginx.service", "-n", "50"]);
    expect(unit.out).toContain("Started nginx.");
    const found = run(["logs", "unit:nginx.service", "-g", "error"]);
    expect(found.out.trim().split("\n")).toEqual([
      "2026-10-03T18:00:02+0000 host nginx[1]: ERROR upstream timed out",
    ]);
    expect(run(["logs", "container:harvest-server-1"]).out).toContain("mongo timeout");
    expect(run(["logs", `file:${root}/var/log/nginx/access.log`, "-g", "wget"]).out).toContain(
      "/.env",
    );
    expect(run(["logs", "container:x;rm -rf /"]).code).toBe(3);
    expect(run(["logs", "file:relative.log"]).err).toMatch(/full path/);
    expect(run(["logs", "file:/var/log/../../etc/shadow"]).code).toBe(3);
  });

  it("follows a log until its channel's input ends, and leaves nothing running", async () => {
    const child = spawn("sh", [script, "logs", "container:harvest-server-1", "-f"], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ORAKNID_MONITOR_ROOT: root },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(out).toContain("line 2");
    // Oraknid closes the channel: the follower stops and the script ends.
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    const left = spawnSync("pgrep", ["-f", `${bin}/docker logs`], { encoding: "utf8" });
    expect(left.stdout.trim()).toBe("");
  });
});
