import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in GitLab or Gitea/Forgejo (ADR-062): the REST API Oraknid reads
 * and writes, answered from real bare repositories in a temporary folder,
 * and git's smart HTTP on the same port (git http-backend), which takes a
 * clone or a push only with the right user and token (Basic auth). Every
 * request is counted; tokens are never in the counted lines.
 */
export interface FakeGitHost {
  url: string;
  /** Each API request, as `METHOD path`. */
  hits: string[];
  /** The git requests that came with credentials: the user given, and whether the token was right. */
  gitAuth: { user: string; ok: boolean }[];
  /** A bare repo's folder, to look at what was pushed. */
  bare(fullName: string): string;
  mergeRequests: { iid: number; source: string; target: string; title: string }[];
  close(): Promise<void>;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

interface Repo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
}

export async function startFakeGitHost(o: {
  kind: "gitlab" | "gitea";
  forgejo?: boolean;
  /** token → login. */
  tokens: Record<string, string>;
  /** Groups the logins belong to (GitLab namespaces, Gitea organisations). */
  groups?: Record<string, number>;
}): Promise<FakeGitHost> {
  const root = mkdtempSync(join(tmpdir(), "oraknid-fake-host-"));
  const repos = new Map<string, Repo>();
  const hits: string[] = [];
  const gitAuth: { user: string; ok: boolean }[] = [];
  const mergeRequests: {
    iid: number;
    source: string;
    target: string;
    title: string;
    body: string;
    author: string;
    full: string;
    at: string;
  }[] = [];
  const bare = (full: string) => join(root, `${full}.git`);

  const make = (owner: string, name: string, priv: boolean, readme: boolean, description = "") => {
    const full = `${owner}/${name}`;
    const dir = bare(full);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "--bare", "-b", "main"]);
    git(dir, ["config", "http.receivepack", "true"]);
    if (readme) {
      const work = mkdtempSync(join(root, "work-"));
      git(work, ["init", "-q", "-b", "main"]);
      const env = ["-c", "user.name=Me", "-c", "user.email=me@example.com"];
      execFileSync(
        "sh",
        [
          "-c",
          `printf '# ${name}\\n\\nHello.\\n' > README.md && mkdir -p src && printf 'export const a = 1;\\n' > src/a.ts`,
        ],
        { cwd: work },
      );
      git(work, ["add", "."]);
      git(work, [...env, "commit", "-q", "-m", "First"]);
      execFileSync("sh", ["-c", "printf 'export const a = 2;\\n' > src/a.ts"], { cwd: work });
      git(work, [...env, "commit", "-q", "-am", "Two\n\nThe second commit."]);
      git(work, ["push", "-q", dir, "main"]);
      rmSync(work, { recursive: true, force: true });
    }
    repos.set(full.toLowerCase(), { owner, name, private: priv, description });
    return full;
  };

  const login = (req: IncomingMessage): string | null => {
    const t =
      (req.headers["private-token"] as string | undefined) ??
      /^token (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return t ? (o.tokens[t] ?? null) : null;
  };

  const heads = (full: string) => {
    const out = git(bare(full), [
      "for-each-ref",
      "refs/heads",
      "--format=%(refname:short) %(objectname)",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(" ") as [string, string];
        return { name, sha };
      });
  };
  const commitsOf = (full: string, ref: string) => {
    try {
      return git(bare(full), ["log", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%B%x1e", ref])
        .split("\x1e")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [sha, parents, author, date, message] = x.split("\x1f") as string[];
          return {
            sha: sha as string,
            parents: (parents ?? "").split(" ").filter(Boolean),
            author: author as string,
            date: date as string,
            message: (message ?? "").trim(),
          };
        });
    } catch {
      return [];
    }
  };
  const diffOf = (full: string, args: string[]) => git(bare(full), ["diff", ...args]);
  const lsTree = (full: string, ref: string, path: string, recursive: boolean) => {
    const out = git(bare(full), [
      "ls-tree",
      "-l",
      ...(recursive ? ["-r", "-t"] : []),
      ref,
      ...(path ? [`${path.replace(/\/$/, "")}/`] : []),
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [meta, p] = l.split("\t") as [string, string];
        const [mode, type, sha, size] = meta.split(/\s+/) as string[];
        return { mode, type, sha, size: size === "-" ? null : Number(size), path: p };
      });
  };

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };

  /** git's smart HTTP, through git http-backend, Basic auth checked first. */
  const smartHttp = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!auth) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' });
      res.end();
      return;
    }
    const [user, token] = Buffer.from(auth, "base64").toString("utf8").split(":") as [
      string,
      string,
    ];
    const who = o.tokens[token];
    const ok = !!who && (o.kind === "gitlab" ? user === "oauth2" : user === who);
    gitAuth.push({ user, ok });
    if (!ok) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="fake"' });
      res.end();
      return;
    }
    const body = await readBody(req);
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method ?? "GET",
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: (req.headers["content-type"] as string) ?? "",
        CONTENT_LENGTH: String(body.length),
        REMOTE_USER: who,
        REMOTE_ADDR: "127.0.0.1",
        GIT_HTTP_MAX_REQUEST_BUFFER: "100M",
      },
    });
    child.stdin.end(body);
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.resume();
    await new Promise((r) => child.on("close", r));
    const all = Buffer.concat(out);
    const cut = all.indexOf("\r\n\r\n");
    const head = all.subarray(0, cut).toString("utf8");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n")) {
      const [k, ...v] = line.split(":");
      if (!k) continue;
      if (k.toLowerCase() === "status") status = Number(v.join(":").trim().split(" ")[0]);
      else headers[k] = v.join(":").trim();
    }
    res.writeHead(status, headers);
    res.end(all.subarray(cut + 4));
  };

  const visible = (who: string) =>
    [...repos.values()].filter(
      (r) =>
        r.owner.split("/")[0]?.toLowerCase() === who.toLowerCase() ||
        (o.groups && r.owner in o.groups),
    );

  // ── GitLab ──────────────────────────────────────────────────────────
  const glProject = (r: Repo) => {
    const full = `${r.owner}/${r.name}`;
    const empty = heads(full).length === 0;
    return {
      id: 1,
      path: r.name,
      path_with_namespace: full,
      namespace: { full_path: r.owner },
      visibility: r.private ? "private" : "public",
      default_branch: empty ? null : "main",
      last_activity_at: "2026-10-05T10:00:00.000Z",
      description: r.description,
      archived: false,
      web_url: `${base}/${full}`,
      http_url_to_repo: `${base}/${full}.git`,
      star_count: 3,
      open_issues_count: 1,
      empty_repo: empty,
    };
  };
  const glCommit = (full: string, c: ReturnType<typeof commitsOf>[number]) => ({
    id: c.sha,
    title: c.message.split("\n")[0],
    message: c.message,
    author_name: c.author,
    authored_date: c.date,
    web_url: `${base}/${full}/-/commit/${c.sha}`,
    parent_ids: c.parents,
  });
  const glDiffs = (text: string) =>
    text
      .split(/^diff --git /m)
      .slice(1)
      .map((part) => {
        const lines = part.split("\n");
        const m = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
        const at = lines.findIndex((l) => l.startsWith("@@"));
        return {
          old_path: m?.[1],
          new_path: m?.[2],
          new_file: lines.some((l) => l.startsWith("new file mode")),
          deleted_file: lines.some((l) => l.startsWith("deleted file mode")),
          renamed_file: false,
          diff: at >= 0 ? `${lines.slice(at).join("\n")}` : "",
        };
      });

  const gitlab = async (req: IncomingMessage, res: ServerResponse, url: URL, who: string) => {
    const p = url.pathname.slice("/api/v4".length);
    const q = url.searchParams;
    if (p === "/user") return json(res, 200, { username: who });
    if (p === "/projects" && req.method === "GET") {
      const all = visible(who).map(glProject);
      const per = Number(q.get("per_page") ?? 20);
      const page = Number(q.get("page") ?? 1);
      const slice = all.slice((page - 1) * per, page * per);
      return json(res, 200, slice, {
        "x-next-page": page * per < all.length ? String(page + 1) : "",
      });
    }
    if (p === "/projects" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8")) as {
        path: string;
        visibility: string;
        description: string;
        initialize_with_readme: boolean;
        namespace_id?: number;
      };
      const owner =
        b.namespace_id !== undefined
          ? (Object.entries(o.groups ?? {}).find(([, id]) => id === b.namespace_id)?.[0] ?? who)
          : who;
      if (repos.has(`${owner}/${b.path}`.toLowerCase()))
        return json(res, 400, { message: { path: ["has already been taken"] } });
      const full = make(
        owner,
        b.path,
        b.visibility !== "public",
        b.initialize_with_readme,
        b.description,
      );
      return json(res, 201, glProject(repos.get(full.toLowerCase()) as Repo));
    }
    const ns = /^\/namespaces\/(.+)$/.exec(p);
    if (ns) {
      const id = o.groups?.[decodeURIComponent(ns[1] as string)];
      return id ? json(res, 200, { id }) : json(res, 404, { message: "404 Namespace Not Found" });
    }
    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(res, 404, { message: "404 Not Found" });
    const full = decodeURIComponent(m[1] as string);
    const r = repos.get(full.toLowerCase());
    if (!r) return json(res, 404, { message: "404 Project Not Found" });
    const rest = m[2] ?? "";
    if (rest === "") return json(res, 200, glProject(r));
    if (rest === "/repository/branches")
      return json(
        res,
        200,
        heads(full).map((h) => ({
          name: h.name,
          commit: { id: h.sha },
          protected: h.name === "main",
        })),
      );
    const br = /^\/repository\/branches\/(.+)$/.exec(rest);
    if (br) {
      const h = heads(full).find((x) => x.name === decodeURIComponent(br[1] as string));
      return h
        ? json(res, 200, { name: h.name, commit: { id: h.sha } })
        : json(res, 404, { message: "404 Branch Not Found" });
    }
    if (rest === "/repository/tree") {
      const entries = lsTree(
        full,
        q.get("ref") ?? "main",
        q.get("path") ?? "",
        q.get("recursive") === "true",
      );
      return json(
        res,
        200,
        entries.map((e) => ({
          name: e.path.split("/").pop(),
          path: e.path,
          type: e.type,
          mode: e.mode,
        })),
      );
    }
    const f = /^\/repository\/files\/(.+)$/.exec(rest);
    if (f) {
      const path = decodeURIComponent(f[1] as string);
      try {
        const content = execFileSync("git", ["cat-file", "blob", `${q.get("ref")}:${path}`], {
          cwd: bare(full),
        });
        return json(res, 200, {
          file_path: path,
          size: content.length,
          encoding: "base64",
          content: content.toString("base64"),
        });
      } catch {
        return json(res, 404, { message: "404 File Not Found" });
      }
    }
    if (rest === "/repository/commits") {
      const list = commitsOf(full, q.get("ref_name") ?? "main");
      if (!list.length) return json(res, 404, { message: "404 Not Found" });
      return json(
        res,
        200,
        list.map((c) => glCommit(full, c)),
      );
    }
    const c = /^\/repository\/commits\/([0-9a-f]+)(\/diff)?$/.exec(rest);
    if (c) {
      const one = commitsOf(full, c[1] as string)[0];
      if (!one) return json(res, 404, { message: "404 Commit Not Found" });
      if (c[2]) return json(res, 200, glDiffs(git(bare(full), ["show", "--format=", one.sha])));
      return json(res, 200, { ...glCommit(full, one), stats: { additions: 1, deletions: 1 } });
    }
    if (rest === "/merge_requests" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8")) as {
        source_branch: string;
        target_branch: string;
        title: string;
        description: string;
      };
      const mr = {
        iid: mergeRequests.length + 1,
        source: b.source_branch,
        target: b.target_branch,
        title: b.title,
        body: b.description,
        author: who,
        full,
        at: new Date().toISOString(),
      };
      mergeRequests.push(mr);
      return json(res, 201, { iid: mr.iid, web_url: `${base}/${full}/-/merge_requests/${mr.iid}` });
    }
    const glMr = (x: (typeof mergeRequests)[number]) => ({
      iid: x.iid,
      title: x.title,
      state: "opened",
      draft: false,
      author: { username: x.author },
      source_branch: x.source,
      target_branch: x.target,
      created_at: x.at,
      updated_at: x.at,
      web_url: `${base}/${full}/-/merge_requests/${x.iid}`,
      description: x.body,
    });
    if (rest === "/merge_requests")
      return json(
        res,
        200,
        q.get("state") === "opened" ? mergeRequests.filter((x) => x.full === full).map(glMr) : [],
      );
    const mr = /^\/merge_requests\/(\d+)(\/commits|\/diffs)?$/.exec(rest);
    if (mr) {
      const x = mergeRequests.find((y) => y.full === full && y.iid === Number(mr[1]));
      if (!x) return json(res, 404, { message: "404 Not found" });
      if (mr[2] === "/commits")
        return json(
          res,
          200,
          commitsOf(full, `${x.target}..${x.source}`).map((cm) => glCommit(full, cm)),
        );
      if (mr[2] === "/diffs")
        return json(res, 200, glDiffs(diffOf(full, [`${x.target}...${x.source}`])));
      return json(res, 200, glMr(x));
    }
    return json(res, 404, { message: "404 Not Found" });
  };

  // ── Gitea / Forgejo ─────────────────────────────────────────────────
  const gtRepo = (r: Repo) => {
    const full = `${r.owner}/${r.name}`;
    const empty = heads(full).length === 0;
    return {
      name: r.name,
      full_name: full,
      owner: { login: r.owner },
      private: r.private,
      default_branch: "main",
      updated_at: "2026-10-05T10:00:00Z",
      description: r.description,
      archived: false,
      fork: false,
      html_url: `${base}/${full}`,
      clone_url: `${base}/${full}.git`,
      stars_count: 2,
      open_issues_count: 0,
      empty,
    };
  };
  const gtCommit = (full: string, c: ReturnType<typeof commitsOf>[number]) => ({
    sha: c.sha,
    html_url: `${base}/${full}/commit/${c.sha}`,
    commit: { message: c.message, author: { name: c.author, date: c.date } },
    author: { login: "me" },
    parents: c.parents.map((sha) => ({ sha })),
  });
  const text = (res: ServerResponse, body: string) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  };

  const gitea = async (req: IncomingMessage, res: ServerResponse, url: URL, who: string) => {
    const p = url.pathname.slice("/api/v1".length);
    const q = url.searchParams;
    if (p === "/user") return json(res, 200, { login: who });
    if (p === "/user/repos" && req.method === "GET") {
      const all = visible(who).map(gtRepo);
      const per = Number(q.get("limit") ?? 30);
      const page = Number(q.get("page") ?? 1);
      const more = page * per < all.length;
      return json(
        res,
        200,
        all.slice((page - 1) * per, page * per),
        more ? { link: `<${base}/api/v1/user/repos?page=${page + 1}>; rel="next"` } : {},
      );
    }
    const create = p === "/user/repos" ? who : /^\/orgs\/([^/]+)\/repos$/.exec(p)?.[1];
    if (create && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8")) as {
        name: string;
        private: boolean;
        description: string;
        auto_init: boolean;
      };
      if (repos.has(`${create}/${b.name}`.toLowerCase()))
        return json(res, 409, { message: "The repository with the same name already exists." });
      const full = make(create, b.name, b.private, b.auto_init, b.description);
      return json(res, 201, gtRepo(repos.get(full.toLowerCase()) as Repo));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(res, 404, { message: "Not Found" });
    const full = `${m[1]}/${m[2]}`;
    const r = repos.get(full.toLowerCase());
    if (!r) return json(res, 404, { message: "The target couldn't be found." });
    const rest = m[3] ?? "";
    if (rest === "") return json(res, 200, gtRepo(r));
    if (rest === "/branches")
      return json(
        res,
        200,
        heads(full).map((h) => ({ name: h.name, commit: { id: h.sha }, protected: false })),
      );
    const br = /^\/branches\/(.+)$/.exec(rest);
    if (br) {
      const h = heads(full).find((x) => x.name === decodeURIComponent(br[1] as string));
      return h
        ? json(res, 200, { name: h.name, commit: { id: h.sha } })
        : json(res, 404, { message: "branch not found" });
    }
    const ct = /^\/contents\/?(.*)$/.exec(rest);
    if (ct) {
      const path = decodeURIComponent(ct[1] ?? "");
      const ref = q.get("ref") ?? "main";
      const exact = lsTree(full, ref, "", true).find((e) => e.path === path);
      if (path && exact && exact.type === "blob") {
        const content = execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], {
          cwd: bare(full),
        });
        return json(res, 200, {
          type: "file",
          name: path.split("/").pop(),
          path,
          size: content.length,
          encoding: "base64",
          content: content.toString("base64"),
          html_url: `${base}/${full}/src/branch/${ref}/${path}`,
        });
      }
      const entries = lsTree(full, ref, path, false);
      return json(
        res,
        200,
        entries.map((e) => ({
          type: e.type === "tree" ? "dir" : "file",
          name: e.path.split("/").pop(),
          path: e.path,
          size: e.size ?? 0,
        })),
      );
    }
    const tr = /^\/git\/trees\/(.+)$/.exec(rest);
    if (tr)
      return json(res, 200, {
        tree: lsTree(full, decodeURIComponent(tr[1] as string), "", true).map((e) => ({
          path: e.path,
          type: e.type,
          size: e.size ?? undefined,
          mode: e.mode,
        })),
        truncated: false,
      });
    if (rest === "/commits") {
      const list = commitsOf(full, q.get("sha") ?? "main");
      if (!list.length) return json(res, 409, { message: "Git Repository is empty." });
      return json(
        res,
        200,
        list.map((c) => gtCommit(full, c)),
      );
    }
    const gc = /^\/git\/commits\/([0-9a-f]+)(\.diff)?$/.exec(rest);
    if (gc) {
      const one = commitsOf(full, gc[1] as string)[0];
      if (!one) return json(res, 404, { message: "sha not found" });
      if (gc[2]) return text(res, git(bare(full), ["show", "--format=", one.sha]));
      return json(res, 200, { ...gtCommit(full, one), stats: { additions: 1, deletions: 1 } });
    }
    if (rest === "/pulls" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString("utf8")) as {
        head: string;
        base: string;
        title: string;
        body: string;
      };
      const pr = {
        iid: mergeRequests.length + 1,
        source: b.head,
        target: b.base,
        title: b.title,
        body: b.body,
        author: who,
        full,
        at: new Date().toISOString(),
      };
      mergeRequests.push(pr);
      return json(res, 201, { number: pr.iid, html_url: `${base}/${full}/pulls/${pr.iid}` });
    }
    const gtPull = (x: (typeof mergeRequests)[number]) => ({
      number: x.iid,
      title: x.title,
      state: "open",
      merged: false,
      user: { login: x.author },
      head: { ref: x.source },
      base: { ref: x.target },
      created_at: x.at,
      updated_at: x.at,
      html_url: `${base}/${full}/pulls/${x.iid}`,
      body: x.body,
    });
    if (rest === "/pulls")
      return json(
        res,
        200,
        q.get("state") === "open" ? mergeRequests.filter((x) => x.full === full).map(gtPull) : [],
      );
    const pl = /^\/pulls\/(\d+)(\/commits|\.diff)?$/.exec(rest);
    if (pl) {
      const x = mergeRequests.find((y) => y.full === full && y.iid === Number(pl[1]));
      if (!x) return json(res, 404, { message: "not found" });
      if (pl[2] === "/commits")
        return json(
          res,
          200,
          commitsOf(full, `${x.target}..${x.source}`).map((c) => gtCommit(full, c)),
        );
      if (pl[2] === ".diff") return text(res, diffOf(full, [`${x.target}...${x.source}`]));
      return json(res, 200, gtPull(x));
    }
    return json(res, 404, { message: "Not Found" });
  };

  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    void (async () => {
      try {
        if (/\.git(\/|$)/.test(url.pathname)) return await smartHttp(req, res, url);
        hits.push(`${req.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/forgejo/v1/version")
          return o.forgejo
            ? json(res, 200, { version: "9.0.0" })
            : json(res, 404, { message: "Not Found" });
        const who = login(req);
        if (!who)
          return json(res, 401, {
            message: o.kind === "gitlab" ? "401 Unauthorized" : "token is required",
          });
        if (o.kind === "gitlab" && url.pathname.startsWith("/api/v4/"))
          return await gitlab(req, res, url, who);
        if (o.kind === "gitea" && url.pathname.startsWith("/api/v1/"))
          return await gitea(req, res, url, who);
        json(res, 404, { message: "Not Found" });
      } catch (e) {
        json(res, 500, { message: (e as Error).message });
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  // One account's repo with history, and one of a group.
  const first = Object.values(o.tokens)[0] ?? "me";
  make(first, "site", true, true, "My site");
  for (const g of Object.keys(o.groups ?? {})) make(g, "tools", false, true, "Group tools");

  return {
    url: base,
    hits,
    gitAuth,
    bare,
    mergeRequests,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
