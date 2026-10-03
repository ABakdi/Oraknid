# Hosting a Nest

The Nest is the relay your phone uses to reach Oraknid. Anyone can host one on a small server with a domain. It stores nothing and reads nothing it carries.

## Private or public

- **Private** (the default): only the daemons you list can connect. Use it for yourself. It has no site: its address shows only "Not found", and it asks search engines not to index anything. Its certificate is still listed in public Certificate Transparency logs, which name the domain; an unguessable name, or a wildcard certificate, keeps it out of sight.
- **Public**: any Oraknid daemon can register itself in one click, with limits per address and per daemon. This server is one.

## One script

On a Debian or Ubuntu server with a domain pointed at it:

```sh
curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/deploy/nest/install.sh -o install.sh
sudo sh install.sh nest.example.com --email you@example.com
```

Add `--public` for a public Nest. The script installs what is missing, runs the Nest in Docker on a local port, adds one nginx site for the domain (checked before nginx reloads, and other sites are left alone) and gets a certificate. It prints the address, daemon id and secret to enter in Oraknid, under **Settings → Devices & phone → The Nest → My own Nest**. Running it again updates the Nest. Several Nests can share one server, one per domain.

On a small server, build the image elsewhere and pass it with `--image`, so the build takes no memory from what already runs there.

## Using a public Nest

In Oraknid, **Settings → Devices & phone → The Nest → Use a public Nest**: enter its address and register. That's all.
