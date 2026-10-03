import type {
  Channel,
  Inhibitor,
  InhibitorState,
  KeychainStore,
  Notification,
  SecretStoreStatus,
} from "@oraknid/os";
import type { OsDeps } from "../os/context.ts";

/** OS stand-ins so daemon tests never touch the real keychain, logind or systemd. */
export function fakeOs(
  opts: {
    keychain?: boolean;
    memoryUsed?: () => number;
    /** One keychain for several daemons, as a desktop has (Audit 2, S2-23). */
    keychainServices?: Map<string, Map<string, string>>;
  } = {},
) {
  // Entries by service, then by name, like the Secret Service's attributes.
  const services = opts.keychainServices ?? new Map<string, Map<string, string>>();
  const entries = (service: string) => {
    const m = services.get(service) ?? new Map<string, string>();
    services.set(service, m);
    return m;
  };
  // The service the daemon keeps its entries under: the last one it named.
  let inUse = "oraknid";
  /** The daemon's own entries, whichever service they are kept under. */
  const store = new Proxy(new Map<string, string>(), {
    get(_, prop) {
      const m = entries(inUse);
      const v = Reflect.get(m, prop, m);
      return typeof v === "function" ? v.bind(m) : v;
    },
  });
  const keychainUp = opts.keychain ?? false;
  const sent: { channel: string; n: Notification }[] = [];

  let state: InhibitorState = { held: false, mode: null, why: null, problem: null };
  const listeners = new Set<(s: InhibitorState) => void>();
  const setState = (s: InhibitorState) => {
    state = s;
    for (const l of listeners) l(s);
  };
  const inhibitor: Inhibitor & { calls: string[] } = {
    calls: [],
    async acquire(why) {
      inhibitor.calls.push(`acquire:${why}`);
      setState({ held: true, mode: "block", why, problem: null });
      return state;
    },
    async release() {
      inhibitor.calls.push("release");
      setState({ held: false, mode: null, why: null, problem: null });
    },
    state: () => state,
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  const channel = (name: "desktop" | "push" | "email"): Channel => ({
    name,
    async send(n) {
      sent.push({ channel: name, n });
      return { delivered: 1, problems: [] };
    },
  });

  const keychainStatus: SecretStoreStatus = keychainUp
    ? { kind: "keychain", available: true, detail: "fake keychain" }
    : { kind: "keychain", available: false, detail: "No keychain in tests." };

  const os: Partial<OsDeps> = {
    sandbox: {
      status: () => ({ available: true, detail: "fake sandbox" }),
      wrap: (s) => ({ command: s.command, args: s.args }),
    },
    inhibitor,
    metrics: {
      async sample(watched) {
        return {
          at: Date.now(),
          system: {
            cpuPercent: 1,
            cores: 4,
            // Half the memory, unless a test says otherwise (share of 1000).
            memoryUsedBytes: Math.round((opts.memoryUsed?.() ?? 0.5) * 1000),
            memoryTotalBytes: 1000,
            diskReadBytesPerSec: 0,
            diskWriteBytesPerSec: 0,
            netRxBytesPerSec: 0,
            netTxBytesPerSec: 0,
          },
          gpus: [],
          processes: watched.map((w) => ({
            ...w,
            processes: 1,
            cpuPercent: 0,
            rssBytes: 1,
            readBytesPerSec: 0,
            writeBytesPerSec: 0,
            vramBytes: 0,
          })),
        };
      },
    },
    keychain: fakeKeychain("oraknid"),
    service: {
      install: () => [],
      uninstall: () => [],
      status: () => ({
        installed: false,
        enabled: false,
        active: false,
        startsAtBoot: false,
        detail: "Not installed as a service.",
        fix: "Run: oraknid install",
      }),
    },
    serviceNotifier: { ready() {}, stopping() {}, startWatchdog: () => () => {} },
    channels: { desktop: channel("desktop"), email: channel("email") },
  };
  function fakeKeychain(service: string): KeychainStore {
    return {
      service,
      probe: async () => keychainStatus,
      status: () => keychainStatus,
      names: async () => [...entries(service).keys()],
      scoped(other) {
        inUse = other;
        return fakeKeychain(other);
      },
      get: async (k) => entries(service).get(k),
      set: async (k, v) => {
        entries(service).set(k, v);
      },
      delete: async (k) => entries(service).delete(k),
    };
  }
  return { os, inhibitor, sent, store, keychainServices: services };
}
