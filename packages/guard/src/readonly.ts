// The read-only list (ADR-053, layer 1): programs that only read, whatever
// their arguments, and for programs that can also change things, the
// arguments with which they only read. The same list holds on this
// computer and on a server, over ssh (ADR-049).

/** Programs that only read whatever their arguments. */
export const READERS = new Set(
  `cat ls head tail less more grep egrep fgrep zgrep zcat bzcat xzcat stat wc du df free uptime uname hostname hostnamectl
   whoami id groups ps pgrep top htop ss netstat ip ifconfig lsof journalctl dmesg date which whereis type file readlink
   realpath basename dirname pwd printenv echo printf test [ true false sleep sort uniq cut tr jq yq nl diff cmp comm
   sha256sum sha1sum sha512sum md5sum b2sum cksum dig host nslookup ping getent lsblk findmnt last w who apt-cache
   dpkg-query rpm timedatectl loginctl lscpu lsmem nproc vmstat iostat mpstat rg ag fd fdfind tree column fold fmt
   strings od hexdump xxd base64 seq expr bc numfmt tac rev look locate mount env cal lsb_release arch getconf
   ulimit locale tty stty`.split(/\s+/),
);

const sub = (a: string[]) => a.find((x) => !x.startsWith("-")) ?? "";

/** For programs that can also change things: the arguments with which they only read. */
export const READS_WITH: Record<string, (args: string[]) => boolean> = {
  systemctl: (a) =>
    /^(status|is-active|is-enabled|is-failed|is-system-running|list-units|list-unit-files|list-timers|list-sockets|list-jobs|show|cat|list-dependencies|get-default)$/.test(
      sub(a) || "status",
    ),
  docker: (a) => readsDocker(a),
  podman: (a) => readsDocker(a),
  "docker-compose": (a) => readsDocker(["compose", ...a]),
  nginx: (a) => a.some((x) => /^-[tTvV]$/.test(x)),
  apache2ctl: (a) => a.some((x) => /^(-t|-S|-M|configtest)$/.test(x)),
  apachectl: (a) => a.some((x) => /^(-t|-S|-M|configtest)$/.test(x)),
  caddy: (a) =>
    /^(version|validate|list-modules|fmt)$/.test(a[0] ?? "") && !a.includes("--overwrite"),
  sed: (a) =>
    !a.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith("--in-place")) &&
    // `w file` and `e` in a script write or run.
    !a.some((x) => /(^|[;}\s])[we]\s/.test(x) || /\/[wWe]\s*\S*$/.test(x)),
  awk: (a) => !a.some((x) => /system\s*\(|\|\s*"|>\s*"|getline|print[^;]*>/.test(x)),
  gawk: (a) => !a.some((x) => /system\s*\(|\|\s*"|>\s*"|getline|print[^;]*>/.test(x)),
  find: (a) =>
    !a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x)),
  rg: (a) => !a.some((x) => x === "--pre" || x.startsWith("--pre=")),
  fd: (a) => !a.some((x) => /^(-x|-X|--exec|--exec-batch)$/.test(x)),
  sort: (a) => !a.some((x) => /^(-o|--output)/.test(x)),
  tree: (a) => !a.some((x) => x === "-o"),
  curl: (a) => readsCurl(a),
  wget: (a) => a.includes("--spider") && !a.some((x) => /^--(post|method|body)/.test(x)),
  nc: (a) => a.some((x) => /^-[a-zA-Z]*z/.test(x)),
  ncat: (a) => a.some((x) => /^-[a-zA-Z]*z/.test(x)),
  apt: (a) => /^(list|show|search|policy|depends|rdepends)$/.test(a[0] ?? ""),
  dpkg: (a) =>
    a.some((x) =>
      /^(-l|-L|-s|-S|--list|--listfiles|--status|--search|--print-architecture)$/.test(x),
    ),
  crontab: (a) => a.includes("-l"),
  ufw: (a) => a[0] === "status",
  iptables: (a) =>
    a.some((x) => /^(-L|--list|-S|--list-rules)$/.test(x)) &&
    !a.some((x) => /^-[ADIRFXNZP]$/.test(x)),
  "fail2ban-client": (a) => /^(status|ping|get|version|-V|--version)$/.test(a[0] ?? ""),
  certbot: (a) => a[0] === "certificates",
  pm2: (a) =>
    /^(list|ls|status|show|describe|jlist|prettylist|logs|info|-v|--version)$/.test(a[0] ?? ""),
  git: (a) => readsGit(a),
  psql: (a) => a.some((x) => x === "-l" || x === "--list" || x === "--version" || x === "-V"),
  mysql: (a) => a.some((x) => x === "--version" || x === "-V"),
  "redis-cli": (a) => /^(ping|info|dbsize|--version)$/i.test(sub(a)),
  kubectl: (a) =>
    /^(get|describe|logs|top|version|explain|api-resources|cluster-info)$/.test(sub(a)),
  helm: (a) => /^(list|ls|status|get|history|version|show|search)$/.test(sub(a)),
  npm: (a) =>
    /^(ls|list|view|info|outdated|why|explain|config|help|-v|--version|root|prefix|bin)$/.test(
      a[0] ?? "",
    ) && !(a[0] === "config" && /^(set|delete|edit)$/.test(a[1] ?? "")),
  pnpm: (a) =>
    /^(ls|list|why|outdated|view|info|-v|--version|root|bin|store)$/.test(a[0] ?? "") &&
    !(a[0] === "store" && a[1] !== "path" && a[1] !== "status"),
  yarn: (a) => /^(list|info|why|outdated|-v|--version)$/.test(a[0] ?? ""),
  node: (a) => a.length === 1 && /^(-v|--version)$/.test(a[0] ?? ""),
  python: (a) => a.length === 1 && /^(-V|--version)$/.test(a[0] ?? ""),
  python3: (a) => a.length === 1 && /^(-V|--version)$/.test(a[0] ?? ""),
  openssl: (a) =>
    /^(x509|s_client|version|req)$/.test(a[0] ?? "") &&
    !a.some((x) => /^-(out|keyout)$/.test(x)) &&
    (a[0] !== "req" || a.includes("-noout")),
  gh: (a) =>
    /^(pr|issue|repo|run|release|workflow)$/.test(a[0] ?? "") &&
    /^(view|list|status|diff|checks)$/.test(a[1] ?? ""),
  tail: () => true,
  du: () => true,
};

/** docker's subcommands that only read. */
export function readsDocker(a: string[]): boolean {
  // Global options with a value (`--context x`, `-H host`) taken off first.
  const args: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string;
    if (/^(-H|--host|--context|-c|--config|-l|--log-level)$/.test(x)) {
      i++;
      continue;
    }
    if (/^(-f|--file|-p|--project-name|--project-directory|--profile|--env-file)$/.test(x)) {
      i++;
      continue;
    }
    if (!x.startsWith("-")) args.push(x);
  }
  const [cmd, next] = args;
  if (cmd === "compose")
    return /^(ps|logs|config|ls|images|top|version|port|events)$/.test(next ?? "");
  if (cmd === "volume" || cmd === "network" || cmd === "image" || cmd === "container")
    return /^(ls|inspect|list)$/.test(next ?? "") || (cmd === "container" && next === "logs");
  if (cmd === "system") return /^(df|info|events)$/.test(next ?? "");
  return /^(ps|logs|inspect|images|stats|version|info|top|port|events|history|diff)$/.test(
    cmd ?? "",
  );
}

/** git's commands that only read. */
export function readsGit(a: string[]): boolean {
  // `git -C dir …`, `-c k=v`, `--no-pager` taken off.
  let i = 0;
  while (i < a.length && (a[i] as string).startsWith("-")) {
    i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(a[i] as string) ? 2 : 1;
  }
  const cmd = a[i] ?? "";
  const rest = a.slice(i + 1);
  if (rest.some((x) => x.startsWith("--output") || (x === "-o" && cmd !== "log"))) return false;
  switch (cmd) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "describe":
    case "ls-files":
    case "ls-tree":
    case "blame":
    case "shortlog":
    case "grep":
    case "cat-file":
    case "rev-list":
    case "merge-base":
    case "name-rev":
    case "reflog":
    case "whatchanged":
    case "count-objects":
    case "check-ignore":
    case "var":
    case "version":
    case "help":
      return cmd !== "reflog" || !/^(expire|delete)$/.test(rest[0] ?? "");
    case "branch":
      return (
        rest.every(
          (x) =>
            /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--verbose|--sort=.*|--format=.*)$/.test(
              x,
            ) || !x.startsWith("-"),
        ) &&
        (rest.length === 0 || rest.some((x) => x.startsWith("-")))
      );
    case "remote":
      return (
        rest.length === 0 ||
        rest.every((x) => x === "-v" || x === "--verbose") ||
        rest[0] === "show" ||
        rest[0] === "get-url"
      );
    case "tag":
      return (
        rest.length === 0 ||
        (rest.every(
          (x) => /^(-l|--list|-n\d*|--contains|--sort=.*)$/.test(x) || !x.startsWith("-"),
        ) &&
          rest.some((x) => /^(-l|--list)$/.test(x)))
      );
    case "config":
      return rest.some((x) => /^(--get|--get-all|--list|-l|--get-regexp|--show-origin)$/.test(x));
    case "stash":
      return /^(list|show)$/.test(rest[0] ?? "");
    case "worktree":
      return rest[0] === "list";
    default:
      return false;
  }
}

/** curl that only reads: no data, no upload, no method other than GET/HEAD, no output file. */
export function readsCurl(a: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as string;
    if (/^(-X|--request)$/.test(x)) {
      if (!/^(GET|HEAD)$/i.test(a[i + 1] ?? "")) return false;
      i++;
      continue;
    }
    if (/^--request=/.test(x) && !/^--request=(GET|HEAD)$/i.test(x)) return false;
    if (/^-[a-zA-Z]*[dFTKoO]/.test(x) && !x.startsWith("--")) return false;
    if (
      /^--(data|form|upload|output|remote-name|json|config|post|cookie-jar|dump-header|trace|libcurl|netrc|stderr)/.test(
        x,
      )
    )
      return false;
    if (/^-[a-zA-Z]*[cDu]/.test(x) && !x.startsWith("--")) return false;
  }
  return true;
}

/** The hosts a curl or wget names. */
export function urlHosts(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = /^(?:https?|ftp):\/\/(?:[^@/\s]*@)?([^/:?#\s]+)/i.exec(a);
    if (m) out.push((m[1] as string).toLowerCase());
  }
  return out;
}

/** Whether a program with these arguments only reads (no redirect looked at). */
export function readsOnlyProgram(program: string, args: string[]): boolean {
  const rule = READS_WITH[program];
  if (rule) return rule(args);
  return READERS.has(program);
}
