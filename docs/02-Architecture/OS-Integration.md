# OS Integration

All OS-specific code is in `packages/os` behind interfaces. Linux in
Phase 1, Windows in the final phase, after everything else works on Linux.

| Interface | Linux (Phase 1) | Windows (final phase) |
| :-- | :-- | :-- |
| `ServiceManager` | Chosen by what PID 1 is (`/proc/1/comm`), then by the tools present; `ORAKNID_SERVICE` overrides ([[ADR-036-One-Script-Install]]). **systemd**: user unit `oraknid.service`: `Type=notify`, `NotifyAccess=all`, `Restart=always`, `WatchdogSec=30`, `TimeoutStopSec=150`, `KillMode=mixed`; `loginctl enable-linger` so it starts at boot. Ready, watchdog and stopping go through `systemd-notify`. **OpenRC**: `/etc/init.d/oraknid` under `supervise-daemon` (respawn after 2 s, `retry="TERM/150/KILL/5"`), `command_user` me, my environment passed through `env` so OpenRC keeps its own `PATH`; `rc-update add oraknid default`. **runit**: `/etc/sv/oraknid/run` (or `/etc/runit/sv`), `chpst -u` me and all my groups, linked into `/var/service` or `/etc/runit/runsvdir/default`. OpenRC and runit are written through `sudo` once. **Anything else** (s6, a container): an XDG autostart entry running `oraknid start` at desktop login, and a message saying so. `oraknid install` writes the one that fits (with my `PATH`), starts it, and prints how to start, stop, disable and read logs with the system's own tools; `oraknid uninstall` removes it. | Windows service (or scheduled task at logon). |
| `Inhibitor` | `systemd-inhibit --what=sleep:idle … sleep infinity` holder ([[ADR-012-Sleep-Inhibition]]). | `PowerSetRequest(PowerRequestSystemRequired)`. |
| `SecretStore` | `@napi-rs/keyring` **pinned** to Secret Service (no silent kernel-keyring fallback), each data folder under its own service `oraknid:<id>` ([[Audit-2]] S2-23). Without it: the encrypted-file store (AES-256-GCM, scrypt), locked until the passphrase is given through `secrets.unlock`. | Credential Manager via the same library. |
| `Metrics` | Read from `/proc`: per process tree (`/proc/<pid>/task/*/children`) CPU ticks, RSS and IO; system CPU, memory, physical-disk and network counters. GPU: `nvidia-smi --query-gpu=…` and `--query-compute-apps=pid,used_memory` per sample. Ollama `/api/ps` for model VRAM comes with the adapter. AMD: `rocm-smi` later. | `systeminformation`, `nvidia-smi`. |
| `Notifier` | `notify-send` (with action to open the UI) for desktop, `web-push` (VAPID keys in the keychain), `nodemailer` for SMTP. | Toast notifications. |
| `Sandbox` | `bwrap`, under a Landlock domain (Linux 6.12+), inside a network namespace of its own through `pasta` when `passt` is installed ([[Sandboxing]], [[Audit-2]]). | Job Object + restricted token, or WSL2 + bwrap (decided in the final phase). |

`oraknid doctor` checks each one and prints what's wrong in plain words.

Related: [[Durability]] · [[Notifications]] · [[Sandboxing]] · [[ADR-012-Sleep-Inhibition]]
