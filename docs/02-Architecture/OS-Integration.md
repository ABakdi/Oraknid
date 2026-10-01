# OS Integration

All OS-specific code is in `packages/os` behind interfaces. Linux in
Phase 1, Windows in the final phase, after everything else works on Linux.

| Interface | Linux (Phase 1) | Windows (final phase) |
| :-- | :-- | :-- |
| `ServiceManager` | systemd **user** unit `oraknid.service`: `Type=notify`, `NotifyAccess=all`, `Restart=always`, `WatchdogSec=30`, `TimeoutStopSec=150`, `KillMode=mixed`; `loginctl enable-linger` so it starts at boot. `oraknid install` writes it (with my `PATH`) and enables it. Ready, watchdog and stopping go through `systemd-notify`. | Windows service (or scheduled task at logon). |
| `Inhibitor` | `systemd-inhibit --what=sleep:idle … sleep infinity` holder ([[ADR-012-Sleep-Inhibition]]). | `PowerSetRequest(PowerRequestSystemRequired)`. |
| `SecretStore` | `@napi-rs/keyring` **pinned** to Secret Service (no silent kernel-keyring fallback). Without it: the encrypted-file store (AES-256-GCM, scrypt), locked until the passphrase is given through `secrets.unlock`. | Credential Manager via the same library. |
| `Metrics` | Read from `/proc`: per process tree (`/proc/<pid>/task/*/children`) CPU ticks, RSS and IO; system CPU, memory, physical-disk and network counters. GPU: `nvidia-smi --query-gpu=…` and `--query-compute-apps=pid,used_memory` per sample. Ollama `/api/ps` for model VRAM comes with the adapter. AMD: `rocm-smi` later. | `systeminformation`, `nvidia-smi`. |
| `Notifier` | `notify-send` (with action to open the UI) for desktop, `web-push` (VAPID keys in the keychain), `nodemailer` for SMTP. | Toast notifications. |
| `Sandbox` | `bwrap` ([[Sandboxing]]). | Job Object + restricted token, or WSL2 + bwrap (decided in the final phase). |

`oraknid doctor` checks each one and prints what's wrong in plain words.

Related: [[Durability]] · [[Notifications]] · [[Sandboxing]] · [[ADR-012-Sleep-Inhibition]]
