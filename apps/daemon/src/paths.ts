import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
  dataDir: string;
  configDir: string;
  db: string;
  backups: string;
  logs: string;
  legs: string;
  /** Written while the daemon runs: `{ pid, port }`. */
  runtimeFile: string;
  daemonLog: string;
}

/** XDG base directories (docs/02-Architecture/Architecture-Overview.md → Paths). */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const dataDir =
    env.ORAKNID_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "oraknid");
  const configDir =
    env.ORAKNID_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "oraknid");
  return {
    dataDir,
    configDir,
    db: join(dataDir, "oraknid.db"),
    backups: join(dataDir, "backups"),
    logs: join(dataDir, "logs"),
    legs: join(dataDir, "legs"),
    runtimeFile: join(dataDir, "daemon.json"),
    daemonLog: join(dataDir, "logs", "daemon.log"),
  };
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7417;

/**
 * Whether `dataDir` is the data folder Oraknid uses when none is chosen
 * (XDG_DATA_HOME/oraknid): the one the keychain entries of before belong
 * to (Audit 2, S2-23).
 */
export function isDefaultDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const { ORAKNID_DATA_DIR: _, ...rest } = env;
  return resolve(dataDir) === resolve(resolvePaths(rest).dataDir);
}
