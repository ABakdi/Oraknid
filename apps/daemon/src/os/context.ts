import {
  type Channel,
  createBwrapSandbox,
  createKeychainStore,
  createLinuxMetrics,
  createSystemdInhibitor,
  createSystemdNotifier,
  createSystemdService,
  type Inhibitor,
  type Metrics,
  type Sandbox,
  type ServiceManager,
  type ServiceNotifier,
} from "@oraknid/os";

/** Everything OS-specific the daemon uses, behind packages/os interfaces. Tests replace parts. */
export interface OsDeps {
  sandbox: Sandbox;
  inhibitor: Inhibitor;
  metrics: Metrics;
  keychain: ReturnType<typeof createKeychainStore>;
  service: ServiceManager;
  serviceNotifier: ServiceNotifier;
  channels: Partial<Record<"desktop" | "push" | "email", Channel>>;
}

export function linuxOs(overrides: Partial<OsDeps> = {}): OsDeps {
  return {
    sandbox: overrides.sandbox ?? createBwrapSandbox(),
    inhibitor: overrides.inhibitor ?? createSystemdInhibitor(),
    metrics: overrides.metrics ?? createLinuxMetrics(),
    keychain: overrides.keychain ?? createKeychainStore(),
    service: overrides.service ?? createSystemdService(),
    serviceNotifier: overrides.serviceNotifier ?? createSystemdNotifier(),
    channels: overrides.channels ?? {},
  };
}
