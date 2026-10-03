import type { BackupTarget, DbKind } from "@oraknid/contracts";
import { q } from "../servers/ssh.ts";

// The native dump and restore of each kind of database (ADR-044), as one
// command run over SSH, inside the database's container with `docker
// exec` when it has one.
//
// The password never goes on a command line: the command reads it as the
// first line of its stdin into a shell variable, exports it under the
// name the tool reads (PGPASSWORD, MYSQL_PWD, REDISCLI_AUTH), and `docker
// exec -e NAME` hands it on from that environment. MongoDB's tools take
// it only from a file: a temporary one, made inside the container, only
// readable by its user, removed when the command ends.

const ENV: Record<DbKind, string> = {
  postgres: "PGPASSWORD",
  mysql: "MYSQL_PWD",
  mongodb: "ORAKNID_MONGO_CONFIG",
  redis: "REDISCLI_AUTH",
  sqlite: "ORAKNID_UNUSED",
};

export const EXT: Record<DbKind, string> = {
  postgres: "sql",
  mysql: "sql",
  mongodb: "archive",
  redis: "rdb",
  sqlite: "sqlite",
};

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
    throw new Error("A Redis backup holds all its databases: leave the database empty.");
}

/** The secret line the command reads first: the password, as the tool takes it. */
export function secretLine(kind: DbKind, password: string | undefined): string {
  if (!password) return "";
  if (/[\r\n]/.test(password)) throw new Error("A password can't have a line break.");
  // A YAML double-quoted string: JSON's is one.
  if (kind === "mongodb") return `password: ${JSON.stringify(password)}`;
  return password;
}

const flag = (name: string, v: string | number | null) => (v === null ? [] : [name, String(v)]);

function connArgs(t: BackupTarget): string[] {
  switch (t.kind) {
    case "postgres":
      return [...flag("-h", t.host), ...flag("-p", t.port), ...flag("-U", t.user)];
    case "mysql":
      return [...flag("-h", t.host), ...flag("-P", t.port), ...flag("-u", t.user)];
    case "mongodb":
      return [
        ...flag("--host", t.host),
        ...flag("--port", t.port),
        ...flag("--username", t.user),
        ...(t.user ? ["--authenticationDatabase", "admin"] : []),
      ];
    case "redis":
      return [...flag("-h", t.host), ...flag("-p", t.port), ...flag("--user", t.user)];
    case "sqlite":
      return [];
  }
}

const args = (a: string[]) => a.map(q).join(" ");

const MONGO_CONFIG = `if [ -n "$ORAKNID_MONGO_CONFIG" ]; then f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; printf '%s\\n' "$ORAKNID_MONGO_CONFIG" > "$f"; unset ORAKNID_MONGO_CONFIG; set -- --config "$f"; fi`;

const REDIS_FILE = `dir=$(rc --raw CONFIG GET dir | sed -n 2p); file=$(rc --raw CONFIG GET dbfilename | sed -n 2p); [ -n "$dir" ] && [ -n "$file" ] || { echo "Redis wouldn't say where its file is (CONFIG GET refused)." >&2; exit 1; }`;

/** Said by a Redis restore once its file is in place, before Redis stops (and its container with it). */
export const PLACED = "oraknid: the backup's file is in place";

/** What runs where the database is: a script for `sh -c`. */
function dumpScript(t: BackupTarget): string {
  const c = args(connArgs(t));
  switch (t.kind) {
    case "postgres":
      return t.database
        ? `exec pg_dump --clean --if-exists --no-owner --no-privileges ${c} -d ${q(t.database)}`
        : `exec pg_dumpall --clean --if-exists ${c}`;
    case "mysql":
      return `B=$(command -v mariadb-dump || command -v mysqldump) || { echo "mysqldump: command not found" >&2; exit 127; }; exec "$B" --single-transaction --quick --routines --triggers ${c} ${t.database ? q(t.database) : "--all-databases"}`;
    case "mongodb":
      return `${MONGO_CONFIG}; mongodump "$@" --archive --quiet ${c}${t.database ? ` --db ${q(t.database)}` : ""}`;
    case "redis":
      // BGSAVE, wait for it, then the RDB file it wrote.
      return `rc() { redis-cli ${c} "$@"; }; out=$(rc BGSAVE 2>&1); case "$out" in *"Background saving started"*|*"already in progress"*|*"scheduled"*) ;; *) echo "$out" >&2; exit 1;; esac; i=0; while rc INFO persistence | tr -d '\\r' | grep -q '^rdb_bgsave_in_progress:1'; do i=$((i+1)); [ $i -gt 7200 ] && { echo "Redis didn't finish its save in two hours." >&2; exit 1; }; sleep 1; done; rc INFO persistence | tr -d '\\r' | grep -q '^rdb_last_bgsave_status:ok' || { echo "Redis's save failed (rdb_last_bgsave_status)." >&2; exit 1; }; ${REDIS_FILE}; cat "$dir/$file"`;
    case "sqlite":
      return `command -v sqlite3 >/dev/null || { echo "sqlite3: command not found" >&2; exit 127; }; f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; sqlite3 ${q(t.path ?? "")} ".backup '$f'" && cat "$f"`;
  }
}

/** Restores from stdin; `from` is the database the backup came from (MongoDB renames). */
function restoreScript(t: BackupTarget, from: string | null): string {
  const c = args(connArgs(t));
  switch (t.kind) {
    case "postgres":
      return t.database
        ? `createdb ${c} ${q(t.database)} 2>/dev/null; exec psql -q -v ON_ERROR_STOP=1 ${c} -d ${q(t.database)} >/dev/null`
        : `exec psql -q ${c} -d postgres >/dev/null`;
    case "mysql":
      return `M=$(command -v mariadb || command -v mysql) || { echo "mysql: command not found" >&2; exit 127; }; ${
        t.database
          ? `{ "$M" ${c} -e ${q(`USE \`${t.database}\``)} 2>/dev/null || "$M" ${c} -e ${q(`CREATE DATABASE \`${t.database}\``)}; } && exec "$M" ${c} ${q(t.database)}`
          : `exec "$M" ${c}`
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
      return `rc() { redis-cli ${c} "$@"; }; [ "$(rc --raw CONFIG GET appendonly | sed -n 2p)" = yes ] && { echo "This Redis keeps an append-only file (appendonly yes), which it loads instead of a backup: turn it off to restore one." >&2; exit 3; }; ${REDIS_FILE}; cat > "$dir/$file.oraknid-restore" && mv "$dir/$file.oraknid-restore" "$dir/$file" && echo "${PLACED}" >&2 && { rc SHUTDOWN NOSAVE >/dev/null 2>&1; true; }`;
    case "sqlite":
      return `command -v sqlite3 >/dev/null || { echo "sqlite3: command not found" >&2; exit 127; }; f=$(umask 077; mktemp) || exit 1; trap 'rm -f "$f"' EXIT; cat > "$f" && sqlite3 ${q(t.path ?? "")} ".restore '$f'"`;
  }
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

export function dumpCommand(t: BackupTarget): string {
  return wrap(t, dumpScript(t));
}

export function restoreCommand(t: BackupTarget, from: string | null): string {
  // A container's Redis comes back up with the file in place.
  const after =
    t.kind === "redis" && t.container
      ? `; r=$?; "$D" start ${q(t.container)} >/dev/null 2>&1; exit $r`
      : "";
  return wrap(t, restoreScript(t, from), after);
}

/** What the tool said, in plain words for me (BR-17); the password never in it. */
export function plainError(
  t: BackupTarget,
  code: number | null,
  stderr: string,
  o: { server: string; user: string; password?: string | undefined },
): string {
  let s = stderr;
  if (o.password) s = s.split(o.password).join("•••");
  const where = t.container ? `the container ${t.container}` : o.server;
  const db = t.database ? `"${t.database}"` : "the database";
  const at = `${t.host ?? "localhost"}${t.port ? `:${t.port}` : ""}`;
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
    /password authentication failed|Access denied for user|Authentication failed|WRONGPASS|NOAUTH|invalid password|no password supplied|fe_sendauth/i.test(
      s,
    )
  )
    return `${KIND_NAMES[t.kind]} refused the login${t.user ? ` of "${t.user}"` : ""}: check the user and password in the plan.`;
  if (/database .* does not exist|Unknown database|doesn't exist/i.test(s))
    return `There's no database ${db} in ${where}.`;
  if (
    /Connection refused|could not connect|Can't connect|Could not connect|connection to server/i.test(
      s,
    )
  )
    return `Nothing answered at ${at} in ${where}: is ${KIND_NAMES[t.kind]} running there, and on that port?`;
  if (/Permission denied/i.test(s))
    return `Permission denied in ${where}: ${s.trim().split("\n").at(-1)?.slice(0, 200)}`;
  if (/appendonly yes/.test(s)) return s.trim();
  const last = s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last
    ? `The ${KIND_NAMES[t.kind]} tool stopped: ${last.slice(0, 300)}`
    : `The ${KIND_NAMES[t.kind]} tool stopped (exit ${code ?? "?"}) without saying why.`;
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
