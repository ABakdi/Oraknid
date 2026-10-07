# Settings and updates

**Settings** (`g ,`) is in tabs; the tab you are on is in the address, so a link can open it directly. A "Settings" link next to a control elsewhere opens the right tab, with a way back.

## General

This computer: its keychain, the sandbox agents run in, and whether Oraknid keeps the machine awake while work runs. How much room Oraknid's data takes, and pruning old logs. Notifications, and the theme.

## Eye & jobs

- **The Eye's models**: which model plans, which decides quick things, and how many rounds an interview may have. See [The Eye's own models](legs.html#the-eyes-own-models).
- **Jobs at once**: how many jobs run at once, how many tasks of one job, and how much of a job Claude may take.
- **Work at once**: tasks across all jobs (Automatic, what this computer can take, or a number), heavy tasks at once, the memory, CPU and disk to keep free, and **Pause work when the computer is busy with my own things**.
- **Same-provider fallback**: when one account reaches its usage limit, whether a task may move to another of your accounts with the same provider. Read the provider's terms before turning it on.

## Security

Your PIN and how soon an idle device locks, the commands always allowed or always blocked, and the [terminal](web-terminal.html), off until you turn it on.

## Devices & phone

Pair a device with a QR code, see the paired devices with their rights (full rights are given or taken on a device's row, at home, with your PIN), and connect a Nest. See [Your phone, from anywhere](phone.html).

## Connections

Mail ([Mail](mail.html)), GitHub accounts ([Repos](repos.html)), and the tools skills use ([Skills](skills.html)).

## Backups

Backup plans for your servers' databases, the latest backups and the encryption keys: see [Backups](backups.html).

## About & updates

The version running, its channel (dev or stable), how it was installed, and when Oraknid last looked for a new version. **Check now** looks at once. Newer releases are listed with their notes; on the dev channel, **New work on dev (N commits)** too. **Update now** asks first, saying how many jobs are running (they pause and carry on after the restart), copies the database, installs the new version and restarts; the page follows it to **Updated to …** and **Reload the page**. If the new version doesn't start, Oraknid goes back to the one you had and says so.

The foot of the sidebar always shows the version and whether an update waits; a click opens this tab. Away from home, only a device with full rights may update. More in [Updating](getting-started.html#updating).

## Asking the helper

Ask the [helper](chats.html) ("run three jobs at once", "turn the terminal off"): it changes any setting this page can, checked the same way, and says what it changed. What this page only allows at home, the helper only does at home.
