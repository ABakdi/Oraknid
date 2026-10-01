import type {
  Channel,
  Inhibitor,
  InhibitorState,
  Notification,
  SecretStoreStatus,
} from "@oraknid/os";
import type { OsDeps } from "../os/context.ts";

/** OS stand-ins so daemon tests never touch the real keychain, logind or systemd. */
export function fakeOs(opts: { keychain?: boolean } = {}) {
  const store = new Map<string, string>();
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
            memoryUsedBytes: 1,
            memoryTotalBytes: 2,
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
    keychain: {
      probe: async () => keychainStatus,
      status: () => keychainStatus,
      get: async (k) => store.get(k),
      set: async (k, v) => {
        store.set(k, v);
      },
      delete: async (k) => store.delete(k),
    },
    service: {
      install: () => [],
      uninstall: () => [],
      status: () => ({
        installed: false,
        enabled: false,
        active: false,
        startsAtBoot: false,
        detail: "Not installed as a service. Run: oraknid install",
      }),
    },
    serviceNotifier: { ready() {}, stopping() {}, startWatchdog: () => () => {} },
    channels: { desktop: channel("desktop"), email: channel("email") },
  };
  return { os, inhibitor, sent, store };
}
