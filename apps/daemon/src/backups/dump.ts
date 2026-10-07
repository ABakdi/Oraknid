import { type BackupTarget, type DbKind, kindOptions } from "@oraknid/contracts";
import { q } from "../servers/ssh.ts";

// The native dump and restore of each kind of database (ADR-044), and
// Test connection's read-only look at it, as one command run over SSH,
// inside the database's container with `docker exec` when it has one.
//
// Secrets never go on a command line: the command reads them as the first
// line of its stdin into a shell variable, exports it under the name the
// tool reads (PGPASSWORD, MYSQL_PWD, REDISCLI_AUTH), and `docker exec -e
// NAME` hands it on from that environment. MongoDB's tools take theirs
// (a password, a connection string) only from a file: a temporary one,
// made inside the container, only readable by its user, removed when the
// command ends. Each kind's own fields (Advanced) are flags or the
// tool's own environment, the same for the dump and for the test.

const ENV: Record<DbKind, string> = {
  postgres: "PGPASSWORD",
  mysql: "MYSQL_PWD",
  mongodb: "ORAKNID_MONGO_CONFIG",
  redis: "REDISCLI_AUTH",
  sqlite: "ORAKNID_UNUSED",
};

/** The file's kind, in its name (`<stamp>-<db>.<ext>.zst[.age]`). */
export function extOf(t: BackupTarget): string {
  switch (t.kind) {
    case "postgres":
      return kindOptions(t).postgres.format === "custom" ? "dump" : "sql";
    case "mysql":
      return "sql";
    case "mongodb":
      return "archive";
    case "redis":
      return "rdb";
    case "sqlite":
      return "sqlite";
  }
}

/** A PostgreSQL backup's format, from its file's name. */
export const pgFormatOf = (path: string | null) =>
  /\.dump\.zst(\.age)?$/.test(path ?? "") ? "custom" : "plain";

export const KIND_NAMES: Record<DbKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL/MariaDB",
  mongodb: "MongoDB",
  redis: "Redis",
  sqlite: "SQLite",
};

const NAME = /^[\w.$-]{1,255}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** A target that can be backed up as written, or a plain-words error. */
export function checkTarget(t: BackupTarget) {
  if (t.container !== null && !CONTAINER.test(t.container))
    throw new Error(`"${t.container}" isn't a container name.`);
  if (t.database !== null && !NAME.test(t.database))
    throw new Error(
      `"${t.database}" isn't a database name Oraknid takes (letters, digits, _ . $ -).`,
    );
  if (t.user !== null && !/^[^\s'"`\\]{1,255}$/.test(t.user))
    throw new Error("The user name can't have spaces or quotes.");
  if (t.host !== null && !/^[\w.:[\]-]{1,255}$/.test(t.host))
    throw new Error(`"${t.host}" isn't a host name or address.`);
  if (t.kind === "sqlite" && !t.path) throw new Error("Give the SQLite database file's path.");
  if (t.kind === "redis" && t.database !== null && !/^\d{1,2}$/.test(t.database))
    throw new Error("Redis's database is a number (0 to 99); a backup holds all of them.");
  if (t.kind === "postgres" && !t.database) {
    const pg = kindOptions(t).postgres;
    if (pg.format === "custom")
      throw new Error(
        "The custom format is one database's: name the database (all of them are dumped as SQL).",
      );
    if (pg.schemas.length) throw new Error("Schemas are a database's: name the database too.");
  }
}

/**
 * The secret line the command reads first: the password as the tool takes
 * it; for MongoDB, its config file's contents (a password, a connection
 * string), as one line of YAML (JSON is YAML).
 */
export function secretLine(
  kind: DbKind,
  password: string | undefined,
  uri?: string | undefined,
): string {
  for (const s of [password, uri])
    if (s && /[\r\n]/.test(s)) throw new Error("A password can't have a line break.");
  if (kind === "mongodb") {
    if (!password && !uri) return "";
    return JSON.stringify({ ...(password ? { password } : {}), ...(uri ? { uri } : {}) });
  }
  return password ?? "";
}

const flag = (name: string, v: string | number | null) => (v === null ? [] : [name, String(v)]);

function connArgs(t: BackupTarget, o: { uri?: boolean } = {}): string[] {
  const k = kindOptions(t);
  switch (t.kind) {
    case "postgres":
      return [...flag("-h", t.host), ...flag("-p", t.port), ...flag("-U", t.user)];
    case "mysql":
      return [...flag("-h", t.host), ...flag("-P", t.port), ...flag("-u", t.user)];
    case "mongodb": {
      const m = k.mongodb;
      const tls =
        m.tls === "off"
          ? []
          : [
              "--ssl",
              ...(m.tls === "insecure"
                ? ["--sslAllowInvalidCertificates", "--sslAllowInvalidHostnames"]
                : []),
            ];
      const read = flag("--readPreference", m.readPreference);
      // The connection string says where and who.
      if (o.uri) return [...tls, ...read];
      const host = m.replicaSet
        ? ["--host", `${m.replicaSet}/${t.host ?? "127.0.0.1"}:${t.port ?? 27017}`]
        : [...flag("--host", t.host), ...flag("--port", t.port)];
      return [
        ...host,
        ...flag("--username", t.user),
        ...(t.user ? ["--authenticationDatabase", m.authSource ?? "admin"] : []),
        ...tls,
        ...read,
      ];
    }
    case "redis": {
      const tls =
        k.redis.tls === "off"
          ? []
          : ["--tls", ...(k.redis.tls === "insecure" ? ["--insecure"] : [])];
      return [...flag("-h", t.host), ...flag("-p", t.port), ...flag("--user", t.user), ...tls];
    }
    case "sqlite":
      return [];
  }
}

const args = (a: string[]) => a.map(q).join(" ");

/** PostgreSQL's TLS, through libpq's own environment. */
function pgEnv(t: BackupTarget): string {
  const mode = kindOptions(t).postgres.sslmode;
  return mode ? `PGSSLMODE=${mode}; export PGSSLMODE; ` : "";
}

/**
 * The MySQL or MariaDB client in "$B" and its TLS flags in $TLS: the two
 * spell them differently (MariaDB --ssl…, MySQL --ssl-mode=…).
 */
function mysqlTls(t: BackupTarget): string {
  const tls = kindOptions(t).mysql.tls;
  if (tls === "default") return "TLS=";
  const maria = {
    off: "--skip-ssl",
    required: "--ssl --skip-ssl-verify-server-cert",
    verify: "--ssl --ssl-verify-server-cert",
  }[tls];
  const mysql = { off: "DISABLED", required: "REQUIRED", verify: "VERIFY_IDENTITY" }[tls];
  return `case "$("$B" --version 2>/dev/null)" in *MariaDB*) TLS=${q(maria)};; *) TLS=--ssl-mode=${mysql};; esac`;
}

const MONGO_CONFIG = `if [ -n "$ORAKNID_MONGO_CONFIG" ]; then f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; printf '%s\\n' "$ORAKNID_MONGO_CONFIG" > "$f"; unset ORAKNID_MONGO_CONFIG; set -- --config "$f"; fi`;

const REDIS_FILE = `dir=$(rc --raw CONFIG GET dir | sed -n 2p); file=$(rc --raw CONFIG GET dbfilename | sed -n 2p); [ -n "$dir" ] && [ -n "$file" ] || { echo "Redis wouldn't say where its file is (CONFIG GET refused)." >&2; exit 1; }`;

/**
 * Each redis-cli call ends in 30 s where `timeout` is there: a Redis not
 * speaking TLS never answers a client that does, and would hold it forever.
 */
const REDIS_RC = `T=; command -v timeout >/dev/null && T="timeout 30"; `;

const need = (tool: string) =>
  `command -v ${tool} >/dev/null || { echo "${tool}: command not found" >&2; exit 127; }`;

/** Said by a Redis restore once its file is in place, before Redis stops (and its container with it). */
export const PLACED = "oraknid: the backup's file is in place";

/** What runs where the database is: a script for `sh -c`. */
function dumpScript(t: BackupTarget, o: { uri?: boolean }): string {
  const c = args(connArgs(t, o));
  const k = kindOptions(t);
  switch (t.kind) {
    case "postgres": {
      const pg = k.postgres;
      if (!t.database) return `${pgEnv(t)}exec pg_dumpall --clean --if-exists ${c}`;
      const opts = [
        ...(pg.format === "custom" ? ["-Fc"] : ["--clean", "--if-exists"]),
        "--no-owner",
        "--no-privileges",
        ...pg.schemas.flatMap((s) => ["-n", s]),
        ...pg.extra,
      ];
      return `${pgEnv(t)}exec pg_dump ${args(opts)} ${c} -d ${q(t.database)}`;
    }
    case "mysql": {
      const m = k.mysql;
      const opts = [
        ...(m.singleTransaction ? ["--single-transaction"] : []),
        "--quick",
        ...(m.routines ? ["--routines"] : []),
        ...(m.events ? ["--events"] : []),
        ...(m.triggers ? [] : ["--skip-triggers"]),
      ];
      return `B=$(command -v mariadb-dump || command -v mysqldump) || { echo "mysqldump: command not found" >&2; exit 127; }; ${mysqlTls(t)}; exec "$B" $TLS ${args(opts)} ${c} ${t.database ? q(t.database) : "--all-databases"}`;
    }
    case "mongodb":
      return `${MONGO_CONFIG}; mongodump "$@" --archive --quiet ${c}${t.database ? ` --db ${q(t.database)}` : ""}`;
    case "redis":
      // BGSAVE, wait for it, then the RDB file it wrote.
      return `${REDIS_RC}rc() { $T redis-cli --no-auth-warning ${c} "$@"; }; out=$(rc BGSAVE 2>&1); case "$out" in *"Background saving started"*|*"already in progress"*|*"scheduled"*) ;; *) echo "$out" >&2; exit 1;; esac; i=0; while rc INFO persistence | tr -d '\\r' | grep -q '^rdb_bgsave_in_progress:1'; do i=$((i+1)); [ $i -gt 7200 ] && { echo "Redis didn't finish its save in two hours." >&2; exit 1; }; sleep 1; done; rc INFO persistence | tr -d '\\r' | grep -q '^rdb_last_bgsave_status:ok' || { echo "Redis's save failed (rdb_last_bgsave_status)." >&2; exit 1; }; ${REDIS_FILE}; cat "$dir/$file"`;
    case "sqlite":
      return `${need("sqlite3")}; f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; sqlite3 ${q(t.path ?? "")} ".backup '$f'" && cat "$f"`;
  }
}

/** Restores from stdin; `from` is the database the backup came from (MongoDB renames). */
function restoreScript(
  t: BackupTarget,
  from: string | null,
  o: { uri?: boolean; pgFormat?: "plain" | "custom" },
): string {
  const c = args(connArgs(t, o));
  switch (t.kind) {
    case "postgres":
      if (o.pgFormat === "custom") {
        if (!t.database) throw new Error("A custom-format dump restores into a named database.");
        return `${pgEnv(t)}createdb ${c} ${q(t.database)} 2>/dev/null; exec pg_restore --clean --if-exists --no-owner --no-privileges ${c} -d ${q(t.database)}`;
      }
      return t.database
        ? `${pgEnv(t)}createdb ${c} ${q(t.database)} 2>/dev/null; exec psql -q -v ON_ERROR_STOP=1 ${c} -d ${q(t.database)} >/dev/null`
        : `${pgEnv(t)}exec psql -q ${c} -d postgres >/dev/null`;
    case "mysql":
      return `M=$(command -v mariadb || command -v mysql) || { echo "mysql: command not found" >&2; exit 127; }; B=$M; ${mysqlTls(t)}; ${
        t.database
          ? `{ "$M" $TLS ${c} -e ${q(`USE \`${t.database}\``)} 2>/dev/null || "$M" $TLS ${c} -e ${q(`CREATE DATABASE \`${t.database}\``)}; } && exec "$M" $TLS ${c} ${q(t.database)}`
          : `exec "$M" $TLS ${c}`
      }`;
    case "mongodb": {
      const rename =
        from && t.database && from !== t.database
          ? ` --nsFrom ${q(`${from}.*`)} --nsTo ${q(`${t.database}.*`)}`
          : t.database
            ? ` --nsInclude ${q(`${t.database}.*`)}`
            : "";
      return `${MONGO_CONFIG}; mongorestore "$@" --archive --drop --quiet ${c}${rename}`;
    }
    case "redis":
      // Its file replaced, then Redis stopped without saving: it loads the file when it starts.
      return `${REDIS_RC}rc() { $T redis-cli --no-auth-warning ${c} "$@"; }; [ "$(rc --raw CONFIG GET appendonly | sed -n 2p)" = yes ] && { echo "This Redis keeps an append-only file (appendonly yes), which it loads instead of a backup: turn it off to restore one." >&2; exit 3; }; ${REDIS_FILE}; cat > "$dir/$file.oraknid-restore" && mv "$dir/$file.oraknid-restore" "$dir/$file" && echo "${PLACED}" >&2 && { rc SHUTDOWN NOSAVE >/dev/null 2>&1; true; }`;
    case "sqlite":
      return `${need("sqlite3")}; f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; cat > "$f" && sqlite3 ${q(t.path ?? "")} ".restore '$f'"`;
  }
}

/**
 * Test connection's look (read only): the dump's tool is there, then its
 * client logs in and prints the server's version on the first line and
 * the databases it sees on the next ones. MongoDB's shell reads its
 * script (with the login) from stdin, after the secret line.
 */
function testScript(t: BackupTarget, o: { uri?: boolean }): string {
  const c = args(connArgs(t, o));
  switch (t.kind) {
    case "postgres": {
      const db = q(t.database ?? "postgres");
      return `${pgEnv(t)}${need(t.database ? "pg_dump" : "pg_dumpall")}; exec psql -X -q -A -t -v ON_ERROR_STOP=1 ${c} -d ${db} -c 'show server_version' -c 'select datname from pg_database where not datistemplate order by 1'`;
    }
    case "mysql":
      return `{ command -v mariadb-dump || command -v mysqldump; } >/dev/null || { echo "mysqldump: command not found" >&2; exit 127; }; B=$(command -v mariadb || command -v mysql) || { echo "mysql: command not found" >&2; exit 127; }; ${mysqlTls(t)}; exec "$B" $TLS ${c} -N -B -e 'select version(); show databases'`;
    case "mongodb":
      return `${need("mongodump")}; S=$(command -v mongosh || command -v mongo) || { echo "mongosh: command not found" >&2; exit 127; }; f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; cat > "$f"; "$S" --nodb --quiet "$f"`;
    case "redis": {
      const n = t.database ? ` -n ${q(t.database)}` : "";
      return `${need("redis-cli")}; ${REDIS_RC}rc() { $T redis-cli --no-auth-warning ${c}${n} "$@"; }; out=$(rc INFO server 2>&1); s=$?; { [ $s -eq 124 ] || [ $s -eq 143 ]; } && { echo "oraknid: Redis gave no answer in 30 seconds (timed out)" >&2; exit 5; }; case "$out" in *"AUTH failed"*|*WRONGPASS*|*NOAUTH*) printf '%s\\n' "$out" | grep -E 'AUTH|WRONGPASS' >&2; exit 1;; esac; v=$(printf '%s\\n' "$out" | tr -d '\\r' | sed -n 's/^redis_version://p'); [ -n "$v" ] || { printf '%s\\n' "$out" >&2; exit 1; }; echo "$v"; rc INFO keyspace | tr -d '\\r' | sed -n 's/^\\(db[0-9]*\\):.*/\\1/p'; d=$(rc --raw CONFIG GET dir 2>&1 | sed -n 2p); [ -n "$d" ] || { echo "Redis wouldn't say where its file is (CONFIG GET refused)." >&2; exit 4; }`;
    }
    case "sqlite":
      return `${need("sqlite3")}; p=${q(t.path ?? "")}; [ -f "$p" ] || { echo "no such file: $p" >&2; exit 2; }; [ -r "$p" ] || { echo "Permission denied: $p" >&2; exit 2; }; exec sqlite3 -readonly "$p" 'select sqlite_version();' '.databases'`;
  }
}

/**
 * MongoDB's test, for mongosh or the legacy mongo shell: logs in with the
 * fields (or the connection string) and prints the version and the
 * databases. It goes on stdin, never on a command line.
 */
export function mongoTestScript(
  t: BackupTarget,
  password: string | undefined,
  uri: string | undefined,
): string {
  const m = kindOptions(t).mongodb;
  const params = [
    ...(m.replicaSet ? [`replicaSet=${m.replicaSet}`] : []),
    ...(m.tls !== "off" ? ["tls=true"] : []),
    ...(m.tls === "insecure" ? ["tlsAllowInvalidCertificates=true"] : []),
    ...(m.readPreference ? [`readPreference=${m.readPreference}`] : []),
    "serverSelectionTimeoutMS=8000",
  ];
  const url = uri ?? `mongodb://${t.host ?? "127.0.0.1"}:${t.port ?? 27017}/?${params.join("&")}`;
  const o = {
    url,
    user: uri ? null : t.user,
    password: uri ? null : (password ?? ""),
    authSource: m.authSource ?? "admin",
  };
  return `var o = ${JSON.stringify(o)};
var c = new Mongo(o.url);
if (o.user) {
  var r = c.getDB(o.authSource).auth(o.user, o.password);
  if (r === 0 || r === false || (r && r.ok === 0)) throw new Error("Authentication failed.");
}
var a = c.getDB("admin");
var b = a.runCommand({ buildInfo: 1 });
var l = a.runCommand({ listDatabases: 1, nameOnly: true });
if (!l.ok) throw new Error(l.errmsg || "listDatabases refused");
print(b.version);
l.databases.forEach(function (d) { print(d.name); });
`;
}

/** The whole command for SSH: read the secret, then run the script on the host or in its container. */
function wrap(t: BackupTarget, script: string, after = ""): string {
  const env = ENV[t.kind];
  const read = `IFS= read -r ORAKNID_S || :; if [ -n "$ORAKNID_S" ]; then ${env}=$ORAKNID_S; export ${env}; fi; unset ORAKNID_S`;
  const run = t.container
    ? `D=$(command -v docker || command -v podman) || { echo "docker: command not found" >&2; exit 127; }; "$D" exec -i -e ${env} ${q(t.container)} sh -c ${q(script)}${after}`
    : `sh -c ${q(script)}`;
  return `sh -c ${q(`${read}; ${run}`)}`;
}

export function dumpCommand(t: BackupTarget, o: { uri?: boolean } = {}): string {
  return wrap(t, dumpScript(t, o));
}

export function restoreCommand(
  t: BackupTarget,
  from: string | null,
  o: { uri?: boolean; pgFormat?: "plain" | "custom" } = {},
): string {
  // A container's Redis comes back up with the file in place.
  const after =
    t.kind === "redis" && t.container
      ? `; r=$?; "$D" start ${q(t.container)} >/dev/null 2>&1; exit $r`
      : "";
  return wrap(t, restoreScript(t, from, o), after);
}

export function testCommand(t: BackupTarget, o: { uri?: boolean } = {}): string {
  return wrap(t, testScript(t, o));
}

/**
 * Each database's size with the plan's login (ADR-043, server insight): a
 * line `name<TAB>bytes` each. PostgreSQL and MySQL/MariaDB only; null for
 * the others. Read only; the password goes on stdin as for a dump.
 */
export function sizeCommand(t: BackupTarget): string | null {
  const c = args(connArgs(t));
  if (t.kind === "postgres") {
    const db = q(t.database ?? "postgres");
    return wrap(
      t,
      `${pgEnv(t)}command -v psql >/dev/null || { echo "psql: command not found" >&2; exit 127; }; exec psql -X -q -A -t -F '\t' -v ON_ERROR_STOP=1 ${c} -d ${db} -c 'select datname, pg_database_size(datname) from pg_database where not datistemplate order by 1'`,
    );
  }
  if (t.kind === "mysql")
    return wrap(
      t,
      `B=$(command -v mariadb || command -v mysql) || { echo "mysql: command not found" >&2; exit 127; }; ${mysqlTls(t)}; exec "$B" $TLS ${c} -N -B -e 'select table_schema, coalesce(sum(data_length + index_length), 0) from information_schema.tables group by table_schema order by 1'`,
    );
  return null;
}

/** `sizeCommand`'s answer, read. */
export function readSizes(stdout: string): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = [];
  for (const line of stdout.split("\n")) {
    const [name, bytes] = line.trim().split("\t");
    const n = Number(bytes);
    if (name && bytes !== undefined && Number.isFinite(n)) out.push({ name, bytes: n });
  }
  return out;
}

/** Test connection's answer: the version on the first line, the databases on the others. */
export function readTest(
  kind: DbKind,
  stdout: string,
): { version: string | null; databases: string[] } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const version = lines[0] ?? null;
  const rest = lines.slice(1);
  // sqlite3's .databases: "main: /srv/app.db r/o".
  const databases =
    kind === "sqlite" ? rest.map((l) => l.split(":")[0] ?? l).filter(Boolean) : rest;
  return { version, databases };
}
/** What the tool said, in plain words for me (BR-17); no secret ever in it. */
export function plainError(
  t: BackupTarget,
  code: number | null,
  stderr: string,
  o: {
    server: string;
    user: string;
    password?: string | undefined;
    uri?: string | undefined;
  },
): string {
  let s = stderr;
  for (const secret of [o.password, o.uri]) if (secret) s = s.split(secret).join("•••");
  // A connection string's password, should a tool repeat it.
  s = s.replace(/(mongodb(?:\+srv)?:\/\/[^:/@\s]*:)[^@\s]*@/g, "$1•••@");
  const where = t.container ? `the container ${t.container}` : o.server;
  const db = t.database ? `"${t.database}"` : "the database";
  const at = `${t.host ?? "localhost"}${t.port ? `:${t.port}` : ""}`;
  const name = KIND_NAMES[t.kind];
  const lastLine = () =>
    s
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const tool = /(\S+): (?:command )?not found/.exec(s)?.[1]?.split("/").pop();
  if (/permission denied.*docker\.sock|connect to the Docker daemon socket/i.test(s))
    return `The SSH user ${o.user} can't use Docker on ${o.server}: add it to the docker group (sudo usermod -aG docker ${o.user}), then try again.`;
  if (/No such container/i.test(s))
    return `There's no container named "${t.container}" on ${o.server}.`;
  if (/is not running/i.test(s) && t.container)
    return `The container "${t.container}" isn't running on ${o.server}.`;
  if (/docker: command not found/.test(s)) return `Docker isn't installed on ${o.server}.`;
  if (tool || code === 127)
    return `${tool ?? "The dump tool"} isn't installed in ${where}: ${KIND_NAMES[t.kind]}'s own tools are needed there.`;
  if (
    /password authentication failed|Access denied for user|Authentication failed|WRONGPASS|NOAUTH|invalid password|invalid username-password|no password supplied|fe_sendauth|AuthenticationFailed/i.test(
      s,
    )
  ) {
    if (t.kind === "mongodb" && !o.uri) {
      const source = kindOptions(t).mongodb.authSource ?? "admin";
      return `MongoDB refused the login${t.user ? ` of "${t.user}"` : ""} against the authentication database "${source}": check the user, the password and the authentication database (Advanced).`;
    }
    return `${name} refused the login${t.user ? ` of "${t.user}"` : ""}: check the user and password in the plan.`;
  }
  if (/database .* does not exist|Unknown database|doesn't exist/i.test(s))
    return `There's no database ${db} in ${where}.`;
  if (/no such file: /.test(s)) return `There's no file ${t.path ?? ""} in ${where}.`;
  if (
    /could not translate host name|Unknown (MySQL|MariaDB) server host|ENOTFOUND|getaddrinfo|Name or service not known|Could not resolve/i.test(
      s,
    )
  )
    return `There's no host "${t.host}" as seen from ${where}: check the host's name.`;
  const k = kindOptions(t);
  const tlsAsked =
    (t.kind === "redis" && k.redis.tls !== "off") ||
    (t.kind === "mongodb" && k.mongodb.tls !== "off");
  if (tlsAsked && /timed out/i.test(s))
    return `${name} gave no answer to TLS at ${at} in ${where}: it may not speak TLS there (check TLS under Advanced).`;
  if (
    /\bSSL\b|\bTLS\b|certificate|handshake/i.test(s) &&
    !/Connection refused|ECONNREFUSED/i.test(s)
  )
    return `${name} and its client didn't agree on TLS in ${where}: ${lastLine().slice(0, 200)} (check TLS under Advanced).`;
  if (
    /Connection refused|ECONNREFUSED|could not connect|Can't connect|Could not connect|connection to server|Server selection timed out|timed out/i.test(
      s,
    )
  )
    return `Nothing answered at ${at} in ${where}: is ${name} running there, and on that port?`;
  if (/CONFIG GET refused/.test(s)) return `${lastLine()} A backup of Redis needs it.`;
  if (/NOPERM|not authorized|permission denied for|command denied/i.test(s))
    return `${name} let ${t.user ? `"${t.user}"` : "the login"} in, but refused what a backup needs: ${lastLine().slice(0, 200)}`;
  if (/Permission denied/i.test(s))
    return `Permission denied in ${where}: ${lastLine().slice(0, 200)}`;
  if (/appendonly yes/.test(s)) return s.trim();
  const last = lastLine();
  return last
    ? `The ${name} tool stopped: ${last.slice(0, 300)}`
    : `The ${name} tool stopped (exit ${code ?? "?"}) without saying why.`;
}

/** Whether the first and last bytes of a dump look like a whole one of its kind. */
export function sane(
  kind: DbKind,
  head: Buffer,
  tail: Buffer,
  size: number,
): { ok: boolean; note: string } {
  const h = head.toString("latin1");
  const tl = tail.toString("latin1");
  const mb =
    size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;
  const ok = (what: string) => ({ ok: true, note: `${mb} of ${what}, complete.` });
  const bad = (why: string) => ({ ok: false, note: why });
  if (size === 0) return bad("It's empty: the dump wrote nothing.");
  switch (kind) {
    case "postgres":
      // pg_dump's custom format (-Fc): "PGDMP", then each table's data
      // in chunks, a table's last chunk a zero length (a sign byte and
      // intSize zero bytes, intSize at offset 8).
      if (h.startsWith("PGDMP")) {
        const intSize = head[8] ?? 4;
        const end = tail.subarray(Math.max(0, tail.length - intSize - 1));
        return end.length === intSize + 1 && end.every((b) => b === 0)
          ? ok("a PostgreSQL custom-format dump")
          : {
              ok: true,
              note: `${mb} of a PostgreSQL custom-format dump: its header is right; it ends without table data to tell its end by (pg_restore --list reads it whole).`,
            };
      }
      if (!/PostgreSQL database (cluster )?dump/.test(h))
        return bad("It doesn't start like a PostgreSQL dump.");
      return /PostgreSQL database (cluster )?dump complete/.test(tl)
        ? ok("a PostgreSQL dump")
        : bad("It's a PostgreSQL dump cut short: its end is missing.");
    case "mysql":
      if (!/-- (MySQL|MariaDB) dump/.test(h)) return bad("It doesn't start like a MySQL dump.");
      return /-- Dump completed/.test(tl)
        ? ok(`a ${h.includes("MariaDB") ? "MariaDB" : "MySQL"} dump`)
        : bad("It's a MySQL dump cut short: its end is missing.");
    case "mongodb":
      // mongodump's archive magic number, 0x8199e26d, little-endian.
      if (head.readUInt32LE(0) !== 0x8199e26d)
        return bad("It doesn't start like a mongodump archive.");
      // The archive ends with a terminator: four 0xFF bytes.
      return tail.length >= 4 && tail.readUInt32LE(tail.length - 4) === 0xffffffff
        ? ok("a MongoDB archive")
        : bad("It's a mongodump archive cut short: its end is missing.");
    case "redis":
      if (!/^REDIS\d{4}/.test(h)) return bad("It doesn't start like a Redis RDB file.");
      // RDB ends with the EOF opcode (0xFF) and an 8-byte checksum.
      return tail.length >= 9 && tail[tail.length - 9] === 0xff
        ? ok(`a Redis RDB file (version ${h.slice(5, 9)})`)
        : bad("It's a Redis RDB file cut short: its end is missing.");
    case "sqlite":
      if (!h.startsWith("SQLite format 3\0"))
        return bad("It doesn't start like a SQLite database.");
      {
        const page = head.readUInt16BE(16) === 1 ? 65536 : head.readUInt16BE(16);
        const pages = head.readUInt32BE(28);
        return pages > 0 && pages * page === size
          ? ok("a SQLite database")
          : bad("It's a SQLite database of the wrong size: cut short.");
      }
  }
}
