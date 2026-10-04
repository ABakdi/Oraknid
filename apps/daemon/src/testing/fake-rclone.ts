import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** What the real rclone v1.75.1 printed for `rclone config providers` (recorded). */
export const RECORDED_PROVIDERS = join(
  import.meta.dirname,
  "../../../../packages/core/src/fixtures/rclone-providers-v1.75.1.json.gz",
);

/** rclone's answer to one step of `config update --non-interactive`. */
export interface FakeStep {
  State: string;
  Option: Record<string, unknown> | null;
  Error?: string;
}

const key = (state: string, result: string) =>
  Buffer.from(`${state}|${result}`).toString("base64url");

/**
 * A stand-in rclone (ADR-046): what the real one would print for Google
 * Drive, Dropbox, MEGA and any backend's sign-in and setup, and every
 * command line it was given written to a log (the state and answers of a
 * setup, which come in its environment, to another). No account is reached.
 *
 * `setup` scripts `config update`: the step for each state and answer
 * ("|" to start); a state not there ends the setup.
 */
export function fakeRclone(
  o: {
    token?: string;
    authorizeFails?: boolean;
    setup?: Record<string, FakeStep>;
    /** `backend features`: what it can say. */
    about?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-fake-rclone-"));
  const log = join(dir, "argv.log");
  const envLog = join(dir, "env.log");
  const bin = join(dir, "rclone");
  const providers = join(dir, "providers.json");
  writeFileSync(providers, gunzipSync(readFileSync(RECORDED_PROVIDERS)));
  const steps = join(dir, "steps");
  mkdirSync(steps);
  for (const [k, step] of Object.entries(o.setup ?? {})) {
    const [state, result] = k.split("|") as [string, string];
    writeFileSync(join(steps, key(state, result ?? "")), JSON.stringify({ Error: "", ...step }));
  }
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
  config)
    sub="$1"; shift
    case "$sub" in
      providers) cat '${providers}' ;;
      update)
        printf 'continue=%s state=%s result=%s\\n' "$RCLONE_CONTINUE" "$RCLONE_STATE" "$RCLONE_RESULT" >> '${envLog}'
        k=$(printf '%s|%s' "$RCLONE_STATE" "$RCLONE_RESULT" | base64 -w0 | tr '+/' '-_' | tr -d '=')
        if [ -f '${steps}'/"$k" ]; then cat '${steps}'/"$k"; else echo '{"State":"","Option":null,"Error":"","Result":""}'; fi
        ;;
      *) echo '{"level":"error","msg":"fake rclone: unknown config command"}' >&2; exit 1 ;;
    esac
    ;;
  backend) echo '{"Name":"x","Features":{"About":${o.about === false ? "false" : "true"},"BucketBased":false}}' ;;
  mkdir) exit 0 ;;
  lsjson) echo "[]" ;;
  size) echo '{"count":0,"bytes":0}' ;;
  about) echo '{"total":16106127360,"used":5368709120,"free":10737418240}' ;;
  *) echo '{"level":"error","msg":"fake rclone: unknown command"}' >&2; exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log, envLog, dir };
}
