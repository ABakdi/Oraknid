export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  active: boolean;
  /** Starts at boot, before login (linger on Linux). */
  startsAtBoot: boolean;
  detail: string;
}

export interface InstallStep {
  step: string;
  ok: boolean;
  detail: string;
}

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
