# OS Integration

All OS-specific code is in `packages/os` behind interfaces. Linux in
Phase 1, Windows in the final phase, after everything else works on Linux.

| Interface | Linux (Phase 1) | Windows (final phase) |
| :-- | :-- | :-- |
| `ServiceManager` | systemd **user** unit `oraknid.service`, `Restart=always`, `WatchdogSec=30`, `loginctl enable-linger` so it starts at boot. `oraknid install` writes and enables it. | Windows service (or scheduled task at logon). |
| `Inhibitor` | `systemd-inhibit --what=sleep:idle … sleep infinity` holder ([[ADR-012-Sleep-Inhibition]]). | `PowerSetRequest(PowerRequestSystemRequired)`. |
| `SecretStore` | `@napi-rs/keyring` → Secret Service. **Warn** if it falls back to the kernel keyring (lost at reboot). Then the encrypted-file store with a passphrase. | Credential Manager via the same library. |
| `Metrics` | Per process: `pidusage` summed over the process tree. System: `systeminformation`. GPU: one long-lived `nvidia-smi --query-gpu=… --query-compute-apps=pid,used_memory -l 2` (CSV), plus Ollama `/api/ps` for model VRAM. AMD: `rocm-smi` later. | `systeminformation`, `nvidia-smi`. |
| `Notifier` | `notify-send` (with action to open the UI) for desktop, `web-push` (VAPID keys in the keychain), `nodemailer` for SMTP. | Toast notifications. |
| `Sandbox` | `bwrap` ([[Sandboxing]]). | Job Object + restricted token, or WSL2 + bwrap (decided in the final phase). |

`oraknid doctor` checks each one and prints what's wrong in plain words.

Related: [[Durability]] · [[Notifications]] · [[Sandboxing]] · [[ADR-012-Sleep-Inhibition]]
