# Backups

Oraknid backs up the databases on your servers: on a schedule, to this computer or to another of your servers, encrypted if you want, and checked when you ask.

## A backup plan

A **plan** is one database (or all of a server's) and what to do with it. Make one in **Settings → Backups → New backup plan**, or from a server's **Backups** tab, where the databases found on it are offered to pick from. A plan says:

- **The database**: PostgreSQL, MySQL or MariaDB, MongoDB, Redis or SQLite; in a Docker container (by its name) or on the server itself (host and port); one database or all of them; the user and its password.
- **When**: every hour, every day at a time, every week, or a cron line, in this computer's time.
- **Where to**: a folder on this computer (`~` is your home), or a folder on another of your servers.
- **How many to keep**: the last so many, and none older than so many days. The newest good backup always stays.
- **Encryption**: an age key, or none.

The password is kept in your keychain. On the server it reaches the dump tool through its environment (or, for MongoDB, a file only you can read that is removed as soon as the dump ends): never on a command line, never in a log.

## How a backup runs

At its time, Oraknid connects to the server over SSH and runs the database's own dump: `pg_dump` (or `pg_dumpall` for all), `mysqldump` or `mariadb-dump`, `mongodump`, a Redis save and its file, a SQLite copy. In a container it runs there with `docker exec`, where those tools always are. The dump streams to Oraknid, is compressed (zstd), encrypted if the plan has a key, and written to its folder; to another server it streams through Oraknid over that server's SSH connection, so nothing is copied between your servers directly and no password is left on either.

Each run is recorded: when, its size, how long it took, a checksum, where it is, and what went wrong in plain words if it failed ("There's no container named shop-db on vps", "PostgreSQL refused the login of app"). A failed backup is a notification (**Settings → General → Notifications**, *A backup failed*).

If Oraknid was off at a plan's time, the backup runs when it's back, once, marked *caught up*.

**Run now** runs a plan at once. The switch on a plan pauses it.

## Encryption keys

Backups are encrypted with [age](https://age-encryption.org). In **Settings → Backups → Encryption keys**:

- **Make a key**: Oraknid makes it, shows its public key (`age1…`), and shows the private key **once**, to download or copy. Keep that file somewhere safe, away from this computer: it's what reads your backups if this computer is lost.
- **Import a key** you already have (`AGE-SECRET-KEY-1…`).

The private key stays in your keychain and is used only to verify and restore. A key a plan uses, or that kept backups were made with, can't be removed.

To read a backup by hand: `age -d -i my-key.txt shop.sql.zst.age | zstd -d > shop.sql`.

## Verify

**Verify** on a backup reads it back: checks its checksum, decrypts it, decompresses it and looks at the dump itself (a whole PostgreSQL or MySQL dump, a complete MongoDB archive, a Redis file, a SQLite database). It says what it found.

## Restore

**Restore** puts a backup back, into the plan's own database or another one (another container, another server). It always takes two steps: first it says exactly what it will replace and where, then you type the database's name to confirm. A Redis restore stops Redis and starts it again with the backup's file.

Restoring is yours: agents can't do it, and the helper can only point you to it. Away from home, it needs a device with full rights.

## Asking the helper

The helper can make plans, change them, run them, verify backups and make keys ("back up the shop database on vps every night at 3, to my storage server, encrypted"). It asks first for anything that writes on a server, never asks you for a password in the chat (add it in the plan's form), and never sees a private key.
