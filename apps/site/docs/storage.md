# Cloud storage

**Cloud storage** (in the sidebar, or `g y`) puts your storage accounts together as one pool: Google Drive, Dropbox, MEGA, and any S3-compatible object storage (MinIO, AWS S3, Cloudflare R2, Backblaze B2, Wasabi). You upload; Oraknid puts each file where it fits, or where you say.

## rclone

Oraknid reaches your accounts through [rclone](https://rclone.org). `install.sh` installs it with your system's package manager; `oraknid doctor` says whether it's there. Without it, the page says how to install it.

Oraknid keeps its own rclone config in its data folder, **encrypted** with a password kept in your keychain. Your keys and tokens are written there and nowhere else: not in Oraknid's database, not in a page, not in a log, never on a command line. Your own rclone setup, if you have one, is left alone.

## Providers

**Add a provider**, then pick its kind:

- **Object storage (S3)**: the service (MinIO, AWS, R2, B2, Wasabi, or another), its endpoint, region, bucket (made when it isn't there), access key and secret key. Object storage can't say how much room it has: give it a **space limit**, or mark it **pay as you go** (never full), so uploads can go there automatically; without either, it's used only when you pick it.
- **Google Drive** or **Dropbox**: **Sign in** opens rclone's own sign-in page; allow it, come back, and **Add**. It uses rclone's app, so there is nothing to register. The sign-in page opens on the computer running Oraknid, so do it there (away from home it says so).
- **MEGA**: your e-mail and password.

Each one can show the whole account, or only a folder of it (*Folder in the account*). A provider is checked when added and shows its **used and free space**; the arrows button checks again. **Edit** renames it (and, for object storage, changes its limit). **Remove** forgets it and its keys; its files stay in the account. A provider that a backup plan or a kept backup needs can't be removed.

## The pool

The pool lists every provider's files at once. Folders of the same name are merged (each shows the providers holding it); each file says where it lives, and the same name in two providers shows twice. The breadcrumbs go back up; the folder you're in is in the address (`/storage/photos/2026`).

- **Upload** (or drop files on the list): several at once, each with its progress, first to Oraknid, then to the provider. A file already there by that name asks before it's replaced.
- **New folder** opens an empty folder; it is kept once a file goes into it.
- **Search** finds files whose name holds your words, in every provider, under the folder you're in.
- A file's **…** menu: **Download**, **Rename or move** (within its provider, or to another one: copied there, then removed), **Delete** (asks first; it can't be undone). A folder renames or deletes in every provider holding it.

Uploads and downloads work in a browser on the computer running Oraknid; away from home you can look, search, move and delete.

## Where uploads go

**Where uploads go** sets it for every upload (the *Upload* menu above the pool can pick one provider for the next ones):

- **Automatic**, by a rule: **most free space first**, **my priority order** (the arrows set it), or **by size**: files from a size you set go to object storage first, smaller ones to the other providers.
- **Always to** one provider.

A file always goes to **one** provider, whole. One too big for any of them is refused before it's sent, saying how much room the biggest has; it is never split.

## Backups

A backup plan can keep its backups in cloud storage: the pool, or one provider. See [Backups](backups.html).

## Asking the helper

The helper can list your providers and a folder, search, upload a file of yours you name ("put ~/Documents/lease.pdf in my storage, in papers"), move a file, and download one to a folder of this computer (never over a file already there). Uploading and deleting are proposed for you to confirm. It won't send hidden files, anything in a hidden folder (your keys, configs) or Oraknid's own data, and nothing it does makes a file public.
