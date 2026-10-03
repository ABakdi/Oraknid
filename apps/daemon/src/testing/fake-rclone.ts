import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in rclone (ADR-046): what the real one would print for Google
 * Drive, Dropbox and MEGA, and every command line it was given written to
 * a log. No account is reached.
 */
export function fakeRclone(o: { token?: string; authorizeFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-fake-rclone-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "rclone");
  const token =
    o.token ??
    '{"access_token":"ya29.fake-access","token_type":"Bearer","refresh_token":"1//fake-refresh","expiry":"2030-01-01T00:00:00Z"}';
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
# The options Oraknid always gives come first.
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift 2 ;;
    --ask-password=false|--use-json-log|-v) shift ;;
    --stats) shift 2 ;;
    *) break ;;
  esac
done
cmd="$1"; shift
case "$cmd" in
  version) echo "rclone v1.75.1-fake" ;;
  obscure) read -r line; printf 'OBSCURED-%s\\n' "$(printf '%s' "$line" | wc -c | tr -d ' ')" ;;
  authorize)
    echo '{"level":"notice","msg":"If your browser doesn'"'"'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=fakeState123"}' >&2
    ${o.authorizeFails ? `sleep 0.3; echo '{"level":"critical","msg":"Failed to authorize: access denied"}' >&2; exit 1` : "sleep 0.3"}
    echo "Paste the following into your remote machine --->"
    echo '${token.replace(/'/g, "'\\''")}'
    echo "<---End paste"
    ;;
  mkdir) exit 0 ;;
  lsjson) echo "[]" ;;
  about) echo '{"total":16106127360,"used":5368709120,"free":10737418240}' ;;
  *) echo '{"level":"error","msg":"fake rclone: unknown command"}' >&2; exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, dir };
}
