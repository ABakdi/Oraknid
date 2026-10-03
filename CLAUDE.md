# Working in this repository

## Containers on this machine: never touch the host's cgroups, /sys or /dev

On 2026-10-03 a systemd test container started with `--privileged`,
`--cgroupns=host` and a read-write bind of `/sys/fs/cgroup` took over the
host's cgroups and killed the desktop session (Hyprland) within a second,
twice; both times the machine needed a hard reboot.

- **Never** run a container here with `--privileged`, `--cgroupns=host`, a
  bind mount of `/sys/fs/cgroup` (or anything under `/sys`, `/dev`, `/run/udev`),
  `--pid=host`, `--net=host` with capabilities, or `--device`.
- **systemd as PID 1** (to test user services, `systemctl`, `loginctl`): don't,
  unless the owner says yes first. If they do, use rootless
  `podman run --systemd=always` or `systemd-nspawn`; with Docker only
  `--cgroupns=private --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --cap-add SYS_ADMIN`,
  never privileged.
- **Before any container** that needs more than a plain unprivileged
  `docker run` (extra capabilities, devices, host namespaces, host mounts other
  than a project folder), ask the owner, saying what it touches and the risk.
- Plain containers are fine: databases, sshd, distro images for the installer,
  each with a throwaway name, removed when done.

## Other rules

- Commit messages never mention the assistant or its maker, and carry no
  attribution or co-author trailers.
- The owner's own Oraknid runs on 127.0.0.1:7417 with data in
  `~/.local/share/oraknid`: tests and checks use their own data folder and port.
- The staging server (95.217.201.11) runs the owner's live apps: read only,
  never stop, restart, install or change anything there.
