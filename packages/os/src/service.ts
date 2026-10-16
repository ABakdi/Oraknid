export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  /** Starts at boot, before login (linger on Linux). */
  startsAtBoot: boolean;
  detail: string;
  /** What to run to put it right, for `oraknid doctor`; null when nothing is wrong. */
  fix: string | null;
}

export interface InstallStep {
  step: string;
  ok: boolean;
  detail: string;
  /** A step that didn't work but leaves the service running: said, not a failure. */
  warning?: boolean;
}

/**
 * What every service's environment carries (ADR-070): a thread pool of 16,
 * so a few slow calls never take every file read and the web UI with them,
 * and the word that a service manager restarts the daemon, so its own
 * self-check may end a daemon that can no longer serve.
 */
export const SERVICE_ENV: Readonly<Record<string, string>> = {
  UV_THREADPOOL_SIZE: "16",
  ORAKNID_SUPERVISED: "1",
};

/** What the service runs: node, the CLI and "run", with the environment it needs. */
export interface ServiceCommand {
  execPath: string;
  args: string[];
  env: Record<string, string>;
}

/** Runs Oraknid as a background service that starts on boot. */
export interface ServiceManager {
  install(command: ServiceCommand): InstallStep[];
  uninstall(): InstallStep[];
  status(): ServiceStatus;
}

/** Tells the service manager the daemon is up, alive, and stopping. */
export interface ServiceNotifier {
  ready(): void;
  stopping(): void;
  /** Starts watchdog pings if the service manager asked for them. Returns a stop function. */
  startWatchdog(): () => void;
}
