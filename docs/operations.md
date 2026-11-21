# Operations

How the product is deployed, reached and checked (plan `docs/plans/2026-11-17-m7-ship.md`, Task 7). Commands run as root on the host named in each section. No server address appears here: the owner's private notes hold them (`<prod-host>`, `<dev-server>`).

Files this runbook uses:

| File | What it is |
|---|---|
| `infra/prod/compose.yaml` | The stack: postgres, core, worker, dashboard, and the one-shot `ops` (profile `ops`) |
| `infra/prod/compose.proxy-network.yaml` | Only for a proxy that runs in Docker: adds core and dashboard to its network |
| `infra/prod/secrets.example/*.env.example` | One placeholder file per env file under `/opt/mkt/secrets/` |
| `infra/prod/proxy/marketing.caddy` | The proxy site, a template (Caddy) |
| `infra/prod/proxy/cloudflare-ips.txt` | Cloudflare's address ranges, dated: the only peers the proxy believes |
| `infra/prod/smoke.mjs` | The smoke check of a deployed origin |
| `infra/prod/firewall/mkt-egress.sh`, `mkt-egress.service` | The egress firewall (the worker's and the backup upload's bridges) and the unit that installs it before Docker starts |
| `infra/prod/backup/backup.sh`, `restore.sh`, `offsite.sh` | The daily encrypted backup and its restore (the `backup` service), and the off-server copy (the `offsite` service); both services use the ops image |
| `infra/prod/backup/mkt-backup.service`, `.timer`, `mkt-backup-alert.service` | The host units: the daily run at 02:30 IST and the alert on its failure |

## Hosts

### Rehearsal host (staging)

Facts gathered read-only on 2026-11-18. This is the staging host, where the work is rehearsed; it is **not** the production host, and these figures are not the production figures for test 41 (spec section 17 is unchanged until the production host is inspected).

| Fact | Value |
|---|---|
| Processors | 4 (`nproc`) |
| Memory | 15 GiB total, about 13 GiB available (`free -h`) |
| Swap | 4 GiB swap file, unused |
| Free disk | 149 GB free of 193 GB on `/` (23 % used) |
| Load | 0.10, 0.26, 0.45 (1, 5, 15 minutes) |
| Docker | Engine 29.9.3 (client and server) |
| Compose | v5.7.1 (the plugin) |
| Proxy | Caddy 2.10.2 (`caddy:2.10-alpine`), in Docker: container `caddy`, compose project in `/opt/stack/caddy`, publishing 80 and 443 on every address, on the external Docker network `web` |
| Proxy configuration | `/opt/stack/caddy/Caddyfile` (global options and snippets) imports `/opt/stack/caddy/sites/*.caddy`, one file per site; the admin endpoint is off (`admin off`), so a change is applied by restarting the container, not by `caddy reload` |
| Client address | Global `trusted_proxies static` with Cloudflare's ranges (identical to `cloudflare-ips.txt` of 2026-11-18) and `client_ip_headers CF-Connecting-IP X-Forwarded-For` |
| TLS | Cloudflare in front (proxied). Caddy issues nothing (`auto_https disable_certs`): each site uses a Cloudflare origin certificate from `/etc/gvcc-certs` (one `.pem` per name, one key) through the `(stg)` snippet |
| Firewall | `ufw` allows SSH, and 80 and 443 from Cloudflare's ranges only; the `DOCKER-USER` chain sends 80 and 443 arriving on the public interface to a Cloudflare-only chain |
| Other tenants | Four other projects' staging, a shared Postgres 16, a MongoDB, the marketing staging deployment of 2026-11-12 (`/opt/stack/marketing-stg`, outside this repository) and the development tooling (`/opt/mkt-dev`) |
| n8n | **Not present** on this host |

### Production host

The owner's dedicated server PROD-C (A1), shared with n8n only. Facts gathered read-only on 2026-11-19, after the deployment, with the commands above:

| Fact | Value |
|---|---|
| System | Ubuntu 24.04.5 LTS, built by the owner's infrastructure project |
| Processors | 4 (`nproc`) |
| Memory | 15 GiB total, about 13 GiB available with the product and n8n running (`free -h`) |
| Swap | 4 GiB swap file, `vm.swappiness` 10, unused |
| Free disk | 180 GB free of 193 GB on `/` (7 % used) |
| Load | about 0.0 at rest |
| Docker | Engine 29.10.0, Compose 5.8.0. `daemon.json` binds published ports to `127.0.0.1` by default and keeps containers running across daemon restarts |
| Proxy | Caddy 2.10 (`caddy:2.10-alpine`) in Docker, compose project in `/opt/stack/caddy`, on the networks `web` and `mkt_proxy` (case 2 above), `admin off`. The marketing site is `/opt/stack/caddy/sites/60-marketing.caddy` |
| TLS | Cloudflare in front, Full (strict). Caddy issues nothing: `import cf gvcc.in` loads the Cloudflare origin certificate in `/etc/gvcc-certs`, which covers `*.gvcc.in` and `*.sarathi.gvcc.in`. The public name goes through a Worker relay ("The public name and its relay", below) |
| Firewall | `ufw`: SSH, and 80 and 443 from Cloudflare's ranges only, with the matching `DOCKER-USER` chain; the product's egress chains (below) come first in `DOCKER-USER` |
| n8n | n8n 2.36.8 in Docker (`/opt/stack/n8n`), no processor or memory limit, about 0.5 GiB in use; its database is on the owner's separate Postgres cluster, reached over a private network |
| Product | Its own Postgres container (owner decision 2026-11-19: not the shared cluster), core, worker and dashboard, within the compose limits (2 processor cores and 4 GB together) |

Test 41 ran on this server on 2026-11-19 with spec section 17's figures unchanged (`docs/acceptance/2026-11-19-test-41.md`).

## How the proxy reaches the app

The core and the dashboard publish `127.0.0.1:4100` and `127.0.0.1:3100` only (`compose.yaml`). Two cases:

1. **Caddy on the host** (a package or binary run by systemd). It reaches those ports directly. Render the site with `__MKT_CORE__ = 127.0.0.1:4100` and `__MKT_DASHBOARD__ = 127.0.0.1:3100`. Nothing else changes. This is the recommended production setup.
2. **Caddy in Docker** (as on staging). A container cannot reach the host's `127.0.0.1`. Give the proxy and this stack a Docker network of their own, shared with nothing else, and start the stack with the override, which adds the core and the dashboard (only) to it under the names `mkt-core` and `mkt-dashboard`:

   ```sh
   docker network create mkt_proxy
   docker network connect mkt_proxy caddy     # a change to the proxy: the owner approves it first
   export MKT_PROXY_NETWORK=mkt_proxy
   docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml -f infra/prod/compose.proxy-network.yaml up -d
   ```

   Render the site with `__MKT_CORE__ = mkt-core:4000` and `__MKT_DASHBOARD__ = mkt-dashboard:3000`. Every later `up`, `restart` or `down` must name both files. `docker network connect` does not survive a re-creation of the proxy container: add the network to the proxy's own compose file too (again with the owner's approval).

   Why a network of its own: every container on that network reaches the core directly, around the proxy, and `TRUST_PROXY=1` is only a count of hops, so the core believes one forwarded address from whoever connects. Any container on the network can therefore send a forged `X-Forwarded-For` straight to the core and get around the invite and sign-in limiters. Joining the proxy's existing shared network instead (on staging, `web`, which other projects' containers are on) is an exception only the owner can approve, knowing that risk.

## Proxy site

The rules (plan decisions 1 and 2; the proxy preconditions of milestones 2b, 2c, 4 and 6 in `docs/progress.md`) are written in the template's header. In short: `/api/` to the core, everything else to the dashboard; path, query string, Host, `Authorization`, the `X-Mkt-*` headers, the raw body and DELETE bodies unchanged; bodies up to 1 MiB, except the document upload (`POST /api/v1/brands/<id>/onboarding/documents`, exactly that path), which takes up to 101 MiB; HSTS and COOP added; `X-Forwarded-For` replaced (never appended) with the client's address, which is believed from `CF-Connecting-IP` only when the request comes from a Cloudflare address.

### Global options

A site file cannot set them; the Caddyfile's global block must contain (every range in `cloudflare-ips.txt`):

```caddyfile
{
	servers {
		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 ... 2c0f:f248::/32
		client_ip_headers CF-Connecting-IP
	}
}
```

Staging's block already has the same ranges, with `X-Forwarded-For` as a second client-address header. Cloudflare always sends `CF-Connecting-IP`, so that makes no difference there; production should name `CF-Connecting-IP` only.

### Render, test, reload

```sh
cd /opt/mkt/marketing    # the repository checkout the stack is built from
sed -e 's/__MKT_HOST__/marketing.sarathi.gvcc.in/' \
    -e 's|__MKT_TLS__|tls /etc/caddy/certs/marketing.pem /etc/caddy/certs/marketing.key|' \
    -e 's/__MKT_CORE__/127.0.0.1:4100/' \
    -e 's/__MKT_DASHBOARD__/127.0.0.1:3100/' \
    infra/prod/proxy/marketing.caddy > /etc/caddy/sites/60-marketing.caddy
grep -c '__MKT_' /etc/caddy/sites/60-marketing.caddy    # must print 0
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

`__MKT_TLS__` is one line as the host issues certificates: a `tls <cert> <key>` line for a Cloudflare origin certificate, `import stg <name>` on staging, or empty for Caddy's automatic HTTPS. With Caddy in Docker the site goes into its sites folder, the check is `docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, and with `admin off` the change is applied by restarting the proxy container, which briefly interrupts every site it serves: agree the moment with the owner first.

**Caddy in Docker (as on staging): the same steps with the container's paths.** The sites folder is the one mounted into the container (`<caddy-dir>/sites` on the host), the certificates are under the container's `/etc/caddy/certs` or wherever its compose file mounts them, and the check and the reload go through the container. A container cannot reach the host's `127.0.0.1`, so the core and the dashboard are the names on the proxy's own network (case 2 above), not `127.0.0.1:4100`:

```sh
cd /opt/mkt/marketing
sed -e 's/__MKT_HOST__/<host>/' \
    -e 's|__MKT_TLS__|import stg <name>|' \
    -e 's/__MKT_CORE__/mkt-core:4000/' \
    -e 's/__MKT_DASHBOARD__/mkt-dashboard:3000/' \
    infra/prod/proxy/marketing.caddy > <caddy-dir>/sites/60-marketing.caddy
grep -c '__MKT_' <caddy-dir>/sites/60-marketing.caddy    # must print 0
docker exec <caddy-container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker restart <caddy-container>    # with `admin off`; this interrupts every site the proxy serves: agree the moment first
```

Run `validate` before the restart, always: a site that does not validate would stop the proxy from coming back, and every site on it with it. The smoke check (below) needs no change for this layout: the proxy publishes 443 on the host, so `--direct https://127.0.0.1:443` reaches it, and `docker run --network host` works as written.

**Staging: the certificate comes first.** The proxy there issues no certificates itself (`auto_https disable_certs`) and the `import stg <name>` snippet loads `<name>.pem` and `<name>.key` from its certificates folder. `validate` fails, inside the running proxy, while they are missing, and a restart with the site in place would then take every staging site down. So, before copying the site in: make a certificate signing request for the name with the staging key, `openssl req -new -key <certs>/staging.key -subj "/CN=<name>" -addext "subjectAltName=DNS:<name>" -out <name>.csr`; in Cloudflare (SSL/TLS, Origin Server, Create Certificate) choose "use my private key" and paste the request; save the certificate it returns as `<certs>/<name>.pem`, and link or copy the key as `<certs>/<name>.key`. One host per certificate: the existing ones are not wildcards. On production a `tls <cert> <key>` line with the origin certificate is used instead, or Caddy's automatic HTTPS.

The proxy's body limit is 1 MiB for every request except the document upload, which gets 101 MiB through two named matchers in the template, so exactly one `request_body` applies to each request. The worker's checkpoints (up to 8 MB) never pass the proxy: in production the worker reaches the core directly (`CORE_URL http://core:4000` in `infra/prod/compose.yaml`). Only browser uploads do, and the core itself refuses a document above its own limit by type (100 MB for a PDF, 5 MB for an image). Deploy the new site file with the usual validate and restart before the first upload of a large PDF.

`infra/prod/test/proxy.test.mjs` renders the template, has the same Caddy validate it, and runs the smoke script and the header, body and address rules through it.

### Cloudflare ranges

Cloudflare changes its ranges rarely and announces it. To refresh: fetch `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`, replace the lists in `cloudflare-ips.txt`, update its date, copy every range into the global `trusted_proxies`, validate and reload. A Cloudflare address missing from the list makes requests from it look like Cloudflare's own address (one shared limiter bucket), never like a forged one.

### The public name and its relay (production, 2026-11-19)

`marketing.sarathi.gvcc.in` is two levels below the zone `gvcc.in`. Cloudflare's free certificate covers one level only (`*.gvcc.in`), and the owner chose not to pay for Advanced Certificate Manager for now. So, as for staging (`stg-marketing-relay`):

| Piece | What it is |
|---|---|
| Worker `marketing-relay` (Cloudflare, Workers & Pages) | Custom domain `marketing.sarathi.gvcc.in`, which gets its own free certificate. Code: `infra/prod/proxy/marketing-relay.js`, pasted in the dashboard editor. It forwards every request unchanged to the origin name and adds `X-Gvcc-Relay: marketing`. Its `workers.dev` address is off |
| DNS `marketing-sarathi.gvcc.in` (A, proxied) | The origin name, covered by the free `*.gvcc.in` certificate |
| Proxy site | Rendered from `marketing.caddy` with `__MKT_HOST__` = `marketing-sarathi.gvcc.in`, then three additions by hand: `@direct not header X-Gvcc-Relay marketing` with `redir @direct https://marketing.sarathi.gvcc.in{uri} 302` after the TLS line, and `header_up Host marketing.sarathi.gvcc.in` and `header_up X-Forwarded-Host marketing.sarathi.gvcc.in` in both `reverse_proxy` blocks. The rendered copy is kept at `/opt/mkt/proxy/60-marketing.relay.caddy` |

`PUBLIC_ORIGIN` stays `https://marketing.sarathi.gvcc.in`. The relay is a same-zone subrequest, so Cloudflare still sends the visitor's own address in `CF-Connecting-IP`. Checked on 2026-11-19: four sign-ins from one address were limited at the fourth (429) while a fifth from another address in the same 10 seconds was not (401). The smoke check runs against the public name without `--direct` (the forged-address checks need the origin's own site name). If the owner later buys Advanced Certificate Manager, remove the Worker's custom domain, point an A record for the public name at the origin, and render the site from the template unchanged.

## First deployment

On the production host, as root, from a checkout of the release (`/opt/mkt/marketing`). Every later deployment repeats steps 2 to 4 in the same order: migrations, then the queue, then core, worker and dashboard, with the core and the worker always together. The firewall from step 4 is already in place by then. Every deployment, the first and every later one, ends with step 11, the firewall check. Every compose command names `--env-file /opt/mkt/compose.env` (step 1).

1. **Folders and secrets.** Every value is generated on the host with `openssl rand` and goes only into these files, never onto a command line that is logged, into the repository or an image:

   ```sh
   install -d -m 0700 -o root -g root /opt/mkt /opt/mkt/secrets
   cd /opt/mkt/marketing
   for f in postgres roles core worker dashboard backup offsite; do
     install -m 0600 -o root -g root infra/prod/secrets.example/$f.env.example /opt/mkt/secrets/$f.env
   done
   install -m 0600 -o root -g root infra/prod/compose.env.example /opt/mkt/compose.env
   ```

   `/opt/mkt/compose.env` holds no secret; its defaults are right unless "Egress firewall", "Settings" below says otherwise.

   Then edit each file and replace every `CHANGE_ME` with its own `openssl rand -hex 32` (hex keeps database URLs valid): the superuser password (twice in `postgres.env`), the four role passwords (`roles.env`, and the same four in the URLs of `core.env` and `worker.env`), and `AUTH_SECRET`, `WORKER_SECRET` (the same in `core.env` and `worker.env`), `ATTEMPT_TOKEN_SECRET` and `TRIGGER_SECRET`. `ANTHROPIC_API_KEY` is the provider's key (A3). `backup.env` and `offsite.env` stay as installed for now (blank values, no `CHANGE_ME`): the owner's age public key and the bucket come later ("Backups" below), and nothing else needs them. Check: `ls -l /opt/mkt/secrets` shows `-rw------- root root` for every file, and `grep -l '^[^#]*CHANGE_ME' /opt/mkt/secrets/*.env` prints nothing (the header comments of the examples name the word, so only lines that are not comments count; the core and the worker refuse to start otherwise). Leave `MKT_SECRETS` unset: it exists only for the tests, and unset the stack reads `/opt/mkt/secrets`.

2. **Build**, the `ops` image included (without `--profile ops` it is not rebuilt, and step 3 would run the old migrations). One image at a time on a shared host:

   ```sh
   for s in core worker dashboard ops backup offsite; do docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops build "$s"; done
   ```

3. **Prepare** the database (migrations, run-time role passwords, the queue): `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm ops prepare`. Its last line is JSON with `"event":"prepared"`.

4. **Egress firewall** (the worker's and the backup upload's), installed before the stack first starts (below). Then **start**: `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml up -d` (add `-f infra/prod/compose.proxy-network.yaml` in case 2 above). Then `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml ps` shows postgres, core, worker and dashboard healthy, `curl -fsS http://127.0.0.1:4100/api/health/ready` answers `{"status":"ok"}`, and `/opt/mkt/firewall/mkt-egress.sh check` prints `mkt-egress: ok`. At the first deployment it also prints `mkt-egress: mkt_backup_egress does not exist yet (the rules are in place for when it does)`: that is expected, because the offsite service creates that network the first time it runs. Run `check` again after the offsite probes in "Check" below, so the bridge-name and IPv6 checks run for it as well.

5. **Dashboard file permissions.** After the first start, `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml logs dashboard | grep -i eacces` must print nothing: an `EACCES` on `.next` means the image's cache folder is not writable by the `node` user.

6. **Worker egress check** from inside the worker (below, "Check").

7. **Proxy site** (above): render, validate, reload.

8. **Model prices and a first exchange rate**, before the first real model call (until then every call succeeds uncosted and is listed for reconciliation). As the database superuser, with the owner's figures (micro-dollars per million tokens; the rate in micro-rupees per dollar, e.g. 83500000 for 83.5):

   ```sh
   docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml exec -T postgres psql -U postgres -d mkt -v ON_ERROR_STOP=1 <<'SQL'
   insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
   values ('<model>', current_date, <input>, <output>, <cache_read>, <cache_write>, 'owner');
   select app.record_fx_rate(current_date, <rate_micros>, 'owner');
   SQL
   ```

9. **Bootstrap**, run by the owner (A9) with the superuser's address in the environment only, never on the command line. The temporary password is printed once, to the owner's terminal:

   ```sh
   # The superuser's address is already on the host, in postgres.env (step 1 generated its password): read it from there,
   # so it is never typed, printed or put on a command line.
   export BOOTSTRAP_DATABASE_URL="$(sed -n 's/^ADMIN_DATABASE_URL=//p' /opt/mkt/secrets/postgres.env)"
   docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml exec -T -e BOOTSTRAP_DATABASE_URL core \
     node apps/core/src/bootstrap.ts --owner-email <owner's email>
   unset BOOTSTRAP_DATABASE_URL
   ```

10. **Smoke check** (below). Every check passes.

11. **Firewall check, the last step of every deployment** (the first and every later one): `/opt/mkt/firewall/mkt-egress.sh check` prints `mkt-egress: ok` (the `mkt_backup_egress does not exist yet` line may precede it only until the offsite service has run once). A deployment is not finished until it does.

## Egress firewall

The stack has two ways out, each an ordinary bridge with a fixed name, a fixed subnet and no IPv6:

| Network | Used by | Bridge | Subnet | Chains |
| --- | --- | --- | --- | --- |
| `mkt_worker_egress` | the worker, for the model provider (ruling R9) | `mkt-egress0` | `10.247.73.0/24` | `MKT-EGRESS-A`/`-B` |
| `mkt_backup_egress` | the `offsite` service, for the off-server backup copy | `mkt-bkegress0` | `10.247.75.0/24` | `MKT-BKEGRESS-A`/`-B` |

`infra/prod/firewall/mkt-egress.sh` applies the same rules to each bridge, in that bridge's own chain. It limits traffic from the bridge to:

- replies to connections already made;
- DNS (UDP and TCP 53) to the host's resolvers only. These come first, because cloud resolvers often sit in 10/8 or 169.254/16;
- then it drops every private, shared, loopback, link-local, multicast and reserved range, and the host's own addresses (`DOCKER-USER`, plus a DROP in `INPUT` for the host's services);
- then it allows TCP 443 and drops everything else.

**Backup upload: owner decision (2026-11-18, ruling R19).** The owner decided the backup upload gets the same limit as the worker: DNS to the host's resolvers, no host or private and special ranges, TCP 443 to public addresses, everything else dropped, failing closed on its own. Each bridge is installed separately, with its own fallback: one failing never leaves the other unprotected, and `install` then exits 1.

**Owner-approved deviation from plan decision 3 (ruling R15, 2026-11-18).** Plan decision 3 says the worker reaches "the model provider only". This firewall enforces TCP 443 to any public address, which is wider. The owner approved that; it does not try to follow the provider's address ranges. A provider-only rule (for example an egress proxy with a host allow-list) would be a later change.

### Settings: `/opt/mkt/compose.env`

One root-owned file, copied from `infra/prod/compose.env.example` at installation (step 1 of "First deployment"), holds the settings that compose and the firewall must agree on. Every compose command reads it through `--env-file /opt/mkt/compose.env`, and the firewall unit reads it through `EnvironmentFile=`. A POSIX shell can source it too. All three readers accept it only in this form:

- one `KEY=value` per line;
- comments on their own lines only (systemd would keep a trailing comment as part of the value);
- double quotes around a value that contains spaces.

The example sets the defaults, and `infra/prod/test/compose.test.mjs` checks that they equal those in `compose.yaml` and `mkt-egress.sh`:

```sh
# The worker's egress bridge, at most 15 characters.
MKT_EGRESS_BRIDGE=mkt-egress0
# The egress subnet. Change it only if this range is already used on the host or its network.
MKT_EGRESS_SUBNET=10.247.73.0/24
# The backup upload's egress bridge (the offsite service), at most 15 characters, firewalled like the worker's.
MKT_BACKUP_EGRESS_BRIDGE=mkt-bkegress0
# Its subnet. Change it only if this range is already used on the host or its network.
MKT_BACKUP_EGRESS_SUBNET=10.247.75.0/24
# The host's upstream DNS resolvers, space-separated, when they cannot be read from resolv.conf at boot:
# MKT_EGRESS_DNS="<resolver> <resolver>"
```

If compose and the firewall disagree on a bridge name, `mkt-egress.sh check` says so.

**Resolvers.** Without `MKT_EGRESS_DNS`, the script reads the IPv4 nameservers in `/run/systemd/resolve/resolv.conf`, or in `/etc/resolv.conf` if that file is missing. It leaves out loopback: `127.0.0.53` is a stub a container cannot use. At boot the unit runs after the network is online and after `systemd-resolved`, and the script waits up to 60 seconds (`MKT_EGRESS_DNS_WAIT`) for a resolver to appear.

If none appears, install **fails closed** and exits 1, and `systemctl status mkt-egress` shows why. Docker still starts, so other projects on the host are not affected. For each bridge:

- If a chain is already in place, it is left exactly as it is.
- Otherwise a chain with no DNS rule is installed: everything but TCP 443 to public addresses is dropped, and since the worker (or the backup upload) cannot resolve names, it reaches nothing until this is fixed.

If an install fails for any other reason before a bridge points at a complete chain, and nothing else covers that bridge, the script drops everything from it until an install succeeds. The other bridge is still installed.

Set `MKT_EGRESS_DNS` in `compose.env` on a host whose resolvers cannot be read that way, or whose resolvers are fixed by hand. Run `systemctl restart mkt-egress.service` whenever they change.

### Install

The rules are keyed on the bridges' names, not on their subnets, so they can be in place before the networks exist. A systemd unit installs them at every boot **before Docker starts**, so neither the worker nor the backup upload ever runs unrestricted: Docker restarts the containers as soon as it starts, and it keeps what is in `DOCKER-USER`. On the production host, before the first `up -d`:

```sh
install -d -m 0755 /opt/mkt/firewall
install -m 0755 infra/prod/firewall/mkt-egress.sh /opt/mkt/firewall/mkt-egress.sh
install -m 0644 infra/prod/firewall/mkt-egress.service /etc/systemd/system/mkt-egress.service
systemctl daemon-reload
systemctl enable --now mkt-egress.service
```

A re-run (a restart of the unit, or a new release of the script) builds each bridge's new rules in its second chain (`MKT-EGRESS-A` and `MKT-EGRESS-B` alternate, and `MKT-BKEGRESS-A` and `-B`), points the bridge at it, and only then removes the old chain. A bridge is never left without rules. On a host where an earlier release of the script covered the worker's bridge only, a restart of the unit (`systemctl restart mkt-egress.service`, after installing the new script and unit as above) adds the backup bridge; run it before the next `up -d`.

On a host that ran a release before the backup bridge was fixed, the network `mkt_backup_egress` may already exist with a random bridge name and subnet, and `check` then says `mkt_backup_egress is not on bridge mkt-bkegress0`. Run `docker network rm mkt_backup_egress` while no offsite run is active (it has no containers between runs; the nightly timer is at 21:00 UTC), then `check` again after the next offsite run, which creates it afresh.

The script refuses loudly if Docker is set to its own nftables firewall backend (`"firewall-backend": "nftables"` in `/etc/docker/daemon.json`; `docker info` shows it as `FirewallBackend`), because then there is no `DOCKER-USER` chain and the rules would not apply. Stop and ask in that case. The `iptables` here is whichever variant the host's Docker uses (legacy or nft). `infra/prod/test/firewall.test.mjs` checks the rule order, the swap, the refusal without a resolver, each bridge failing closed on its own, and `check` for both bridges.

A test stack (`infra/prod/test/stack.test.mjs`, project `mkt-m7test`, and `backup.test.mjs`) uses its own bridges (`mkt-m7t-egress0`, `mkt-m7t-bkegr0`) and subnets (`10.247.74.0/24`, `10.247.76.0/24`), so it can run on a host beside `mkt`; it also publishes the core and the dashboard on `4110` and `3110` (`MKT_CORE_PORT` and `MKT_DASHBOARD_PORT`; the defaults are `4100` and `3100`), so they do not clash with a running `mkt`. It installs no firewall. A hand-run rehearsal should do the same, setting `MKT_EGRESS_BRIDGE`, `MKT_EGRESS_SUBNET`, `MKT_BACKUP_EGRESS_BRIDGE`, `MKT_BACKUP_EGRESS_SUBNET`, `MKT_CORE_PORT` and `MKT_DASHBOARD_PORT` to unused values in its own shell (not a port a browser refuses, such as 4190).

### Check

After `up -d`, run each command below:

```sh
/opt/mkt/firewall/mkt-egress.sh check   # mkt-egress: ok (mkt-egress0 MKT-EGRESS-A, mkt-bkegress0 MKT-BKEGRESS-A), A or B: both bridges' rules, backend, bridge names, IPv6 off
W='docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml exec -T worker node -e'
$W "fetch('https://api.anthropic.com/').then(r=>console.log('443 ok',r.status),e=>console.log('443 blocked',e.cause?.code))"   # 443 ok
$W "fetch('http://example.com/').then(r=>console.log('80 open',r.status),e=>console.log('80 blocked',e.cause?.code))"           # 80 blocked
HOST_IP=$(hostname -I | cut -d' ' -f1)
$W "fetch('https://$HOST_IP/',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('host open'),e=>console.log('host blocked'))"  # host blocked
# The backup upload's bridge, from a one-off offsite container (it runs only once a day otherwise):
O='docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T --entrypoint node offsite -e'
$O "fetch('https://www.cloudflare.com/').then(r=>console.log('443 ok',r.status),e=>console.log('443 blocked',e.cause?.code))"  # 443 ok
$O "fetch('http://example.com/').then(r=>console.log('80 open',r.status),e=>console.log('80 blocked',e.cause?.code))"         # 80 blocked
```

## Smoke check

`node infra/prod/smoke.mjs <origin>` checks: `/api/health/ready` and `/api/health/worker` answer 200; `/` answers 200 with the app's security headers and the proxy's HSTS and COOP; `/api/v1/session` without a cookie answers 401; a trigger with a query string is refused by the core (`trigger_refused`; skipped, so exit 2, without `--trigger-secret-file`, because without the secret a dropped query string cannot be told from a kept one); a DELETE body reaches the core; a 900 kB checkpoint body is not refused by the proxy; a 2 MiB POST to a documents upload path, with no session, is not refused by the proxy (a 413 fails it; the core's 401 or 403 passes it); and, sent to the origin server directly (not through Cloudflare) with forged `CF-Connecting-IP` and `X-Forwarded-For`, both the invite limiter and the sign-in limiter limit by the real address. One line per check; exit 0 when all pass, 1 when one fails, 2 when some were skipped. It prints statuses and error codes only. Its options are in the script's header.

From anywhere, through Cloudflare (the forged-address checks are skipped, exit 2):

```sh
node infra/prod/smoke.mjs https://marketing.sarathi.gvcc.in
```

On the host, the full run. `--direct` reaches the proxy on the host itself, around Cloudflare; the trigger secret proves a correctly signed call passes unchanged. Node runs in the core's image, so the host needs none:

```sh
cd /opt/mkt/marketing
(umask 077 && sed -n 's/^TRIGGER_SECRET=//p' /opt/mkt/secrets/core.env > /root/.mkt-smoke-trigger)
docker run --rm --network host --user 0 --entrypoint node \
  -v "$PWD/infra/prod/smoke.mjs:/tmp/smoke.mjs:ro" -v /root/.mkt-smoke-trigger:/tmp/trigger:ro \
  mkt-core /tmp/smoke.mjs https://marketing.sarathi.gvcc.in \
  --direct https://127.0.0.1:443 --trigger-secret-file /tmp/trigger
rm -f /root/.mkt-smoke-trigger
```

`--user 0`: the image runs as `node`, which cannot read the root-only secret file.

Side effects, all expected: invite look-ups from the host's own address are locked for 15 minutes, so a second run within 15 minutes fails `forged-invite` as "already locked" (by design: it could prove nothing; likewise `forged-sign-in` within 10 seconds); a few failed sign-ins for made-up `@example.invalid` addresses and one `trigger.received` entry for workflow `smoke-check` appear in the audit log. `/api/health/worker` answers 503 until the worker has stamped its first heartbeat (it does so at start) and whenever it has been silent for 15 minutes.

## Backups

Plan decision 6. Every night at 02:30 IST (21:00 UTC) `mkt-backup.timer` starts `mkt-backup.service`, which runs `infra/prod/backup/backup.sh` in the `backup` service (the ops image, which has `pg_dump` 17, `age` and `rclone`). It dumps the whole database `mkt`, every schema, in one consistent snapshot (`pg_dump --format=custom`), and the roles (`pg_dumpall --roles-only --no-role-passwords`). Each stream goes straight into `age`, encrypted to the owner's public key: nothing is written unencrypted, and the server has no key that can read its own backups. Into `/opt/mkt/backups` (root, 0700) it writes one set:

| File | What it is |
|---|---|
| `mkt-<UTC timestamp>.dump.age`, `.dump.age.sha256` | The database, encrypted, and its checksum |
| `mkt-<UTC timestamp>.roles.sql.age`, `.roles.sql.age.sha256` | The roles, without passwords, encrypted, and its checksum |

Then it keeps the newest **7** sets on the server, removing older sets whole. It exits non-zero on any failed step and on a dump under 1 kB; a failed run removes its own partial files. Its log is one JSON line per outcome in `journalctl -u mkt-backup.service`: `backup_done` (name, dump size, sets removed), `backup_refused` (a setting is missing or malformed: `BACKUP_AGE_RECIPIENT` blank, `ADMIN_DATABASE_URL` not a valid address; the address itself is never printed), and `backup_failed` with the step (`settings`, `connection`, `folder`, `pg_dump`, `dump_size`, `pg_dumpall`, `checksum`, `retention`) and exit code. The tools' own messages are not logged, since they can carry addresses or data; to see one, run that step by hand in the backup container.

When the backup succeeded, the same unit runs `infra/prod/backup/offsite.sh` in the `offsite` service: the off-server copy (ruling R18 splits it from the backup). It copies the newest complete set in `/opt/mkt/backups` (four files, both checksums holding) to `<RCLONE_REMOTE>/daily/`, and to `<RCLONE_REMOTE>/monthly/` when that prefix has no set of the set's month yet. It logs `offsite_copied` (name, and whether the monthly copy was made), `offsite_skipped` while `RCLONE_REMOTE` is blank (the run succeeds), or `offsite_failed` with the step (`find_set`: no complete set; `daily`; `monthly`) and exit code; a failure fails the unit.

On a failure of either, systemd starts `mkt-backup-alert.service` (`OnFailure=`), which runs `ops alert backup_failed`: a **severity 1** platform alert, written with `app.raise_alert` (the function the core's `raiseAlert` uses) through the superuser's address in `postgres.env`, so no secret is on a command line. The core delivers it to every platform owner by email at its next notify run (the worker timer's `/worker/reconcile`, every `RECONCILE_INTERVAL_SECONDS`). The second alert channel is not configured (owner decision A11): the core still tries it, so until that is changed the alert view shows each alert as not delivered or `delivery_stalled` even though the email went out. While that alert is unresolved, another failure adds no second one. If the database itself is down, the alert unit fails too; `systemctl --failed` then lists both units.

The two services are split by what they hold. `backup` has the database's credentials (`postgres.env`) and the age public key (`backup.env`), writes `/opt/mkt/backups`, and is on `data` only: no way out. `offsite` sees `/opt/mkt/backups` read-only, holds only the remote's settings (`offsite.env`, no database setting), and is on its own `backup_egress` only: it cannot reach postgres. The host firewall limits `backup_egress` (bridge `mkt-bkegress0`) as it limits the worker's: DNS to the host's resolvers and TCP 443 to public addresses only (owner decision 2026-11-18, ruling R19; "Egress firewall" above). The bucket's endpoint is reached over HTTPS, so nothing else is needed.

### Install

On the production host, as root, after the first deployment. Nothing here touches the staging host's own `gvcc-backup` unit.

**Rehearsal host.** The staging rehearsal did install `mkt-backup.timer` (the owner's binding decision), so it uploads nightly. Its remote prefix must not be production's: use a separate one (`r2:mkt-backups/staging`). The bucket's lifecycle rules for `mkt/daily/` and `mkt/monthly/` do not cover that prefix: add rules for it, or its sets accumulate. When the rehearsal ends, disable the timer (`systemctl disable --now mkt-backup.timer`).

1. **The owner's key pair**, made by the owner on the owner's own machine, never on the server: `age-keygen -o mkt-backup-identity.txt`. The file is the private key: keep it off the server, in two places. Its `# public key: age1...` line is the recipient: put that value in `/opt/mkt/secrets/backup.env` as `BACKUP_AGE_RECIPIENT` (installed in "First deployment", step 1). Until it is there, the backup refuses (`backup_refused`, naming the variable) and the alert is raised.
2. **The folder and the units:**

   ```sh
   install -d -m 0700 -o root -g root /opt/mkt/backups
   cd /opt/mkt/marketing
   for u in mkt-backup.service mkt-backup.timer mkt-backup-alert.service; do
     install -m 0644 infra/prod/backup/$u /etc/systemd/system/$u
   done
   systemctl daemon-reload
   systemctl enable --now mkt-backup.timer
   ```

3. **Run it once by hand** and check: `systemctl start mkt-backup.service` (it waits for the run), then `journalctl -u mkt-backup.service -n 5 -o cat` shows `"event":"backup_done"` then `"event":"offsite_copied"` (or `offsite_skipped` before the bucket is set up), `ls -l /opt/mkt/backups` shows the four files `-rw------- root root`, and `systemctl list-timers mkt-backup.timer` shows the next run at 21:00 UTC.
4. **A restore rehearsal** on a machine where the owner can bring the private key (below, "Restore"), at least once before go-live and after any change to the database's shape.

### Off-server copy (A4)

The bucket is `mkt-backups` (R2). Until `offsite.env` is filled in, `RCLONE_REMOTE` stays blank and every run logs `offsite_skipped`. To set it up:

1. In `/opt/mkt/secrets/offsite.env`, set `RCLONE_REMOTE=r2:mkt-backups/mkt` and uncomment and fill in the `RCLONE_CONFIG_R2_*` lines with an access key scoped to the backup bucket(s) with Object Read & Write. Read is needed as well as write: `rclone copyto --immutable` reads each object (HEAD) before writing it, and never overwrites one that differs.
2. Check the remote from the offsite container: `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T --entrypoint rclone offsite lsf r2:mkt-backups/mkt/daily`. Then `systemctl start mkt-backup.service` logs `offsite_copied`, and the same `lsf` lists the four files (the first run of a month also fills `mkt/monthly/`). From then on a failed copy fails the run and raises the alert.
3. **Retention off the server: 30 daily and 12 monthly.** On the server the backup keeps 7; off it, the bucket's lifecycle rules do (Cloudflare dashboard, R2, `mkt-backups`, Settings, Object lifecycle rules): prefix `mkt/daily/` deletes objects 30 days after upload, prefix `mkt/monthly/` deletes them 365 days after upload. `offsite.sh` puts one set a month in `mkt/monthly/`: the first complete set it copies in a month (by the set's UTC timestamp) for which `mkt/monthly/` has none yet, so a missed day is caught up by the next run.

### Restore

Into an **empty** database only: `restore.sh` refuses a target that has any table in schema `app`. It checks the `.sha256` files when they are beside the backups, creates the roles that are missing (the dump has no passwords), then restores the dump in one transaction that stops at the first error. The target's address names the superuser and no password (an address with a password is refused); the password comes from `PGPASSWORD`.

For a whole-server restore: deploy steps 1 and 2 of "First deployment" on the new host, with a new, empty volume, then install the egress firewall ("Egress firewall", "Install" above: the script and the unit, `systemctl enable --now`), so the pull below is firewalled too, and `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml up -d --wait postgres`. Bring the set into `/opt/mkt/backups`: from the bucket, through the offsite container (its `/backups` is read-only, so into a second folder first): `install -d -m 0700 /opt/mkt/restore-in`, then `docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops run --rm -T -v /opt/mkt/restore-in:/in --entrypoint rclone offsite copy r2:mkt-backups/mkt/daily /in --include "mkt-<ts>.*"`, then `mv /opt/mkt/restore-in/* /opt/mkt/backups/`. Then, as root:

```sh
C='docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml'
# The owner pastes the private key; it is on the server only for the restore, in memory (tmpfs), never on disk.
install -d -m 0700 /dev/shm/mkt-restore
(umask 077 && cat > /dev/shm/mkt-restore/id)
# The superuser password is the POSTGRES_PASSWORD line of postgres.env (written in step 1 of "First deployment"):
PGPASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/mkt/secrets/postgres.env) && export PGPASSWORD
$C --profile ops run --rm -T -e PGPASSWORD -e AGE_IDENTITY_FILE=/key/id -v /dev/shm/mkt-restore:/key:ro \
  --entrypoint mkt-restore backup \
  /backups/mkt-<ts>.dump.age /backups/mkt-<ts>.roles.sql.age postgres://postgres@postgres:5432/mkt
rm -rf /dev/shm/mkt-restore; unset PGPASSWORD
$C --profile ops run --rm ops prepare      # gives the run-time roles their passwords; migrates nothing
```

The last line of the restore is `"event":"restored"`. Then continue with step 4 of "First deployment" (firewall, start) and the smoke check. The audit chains are checked by the next daily `audit_verify` duty; to check at once, compare the restored database's row counts with the old one's if it still exists.

`infra/prod/test/backup.test.mjs` rehearses all of this on throw-away containers (project `mkt-m7test-bk`): a backup restored into a clean postgres has the same row counts in `app`, `auth`, `audit` and `pgboss`, its audit chains verify with the core's `verifyAudit`, also for a backup taken while 50 audit entries are being written; a read-only folder fails the run; a target with `app` tables is refused; the files do not open with another key; 7 sets are kept; a malformed `ADMIN_DATABASE_URL` fails without its password reaching the log; the offsite service copies the newest complete set to `daily/` and once a month to `monthly/`, fails with no complete set or a bad remote, and can neither write the backups nor reach the database; and the alert command works.

### Restore drill

Acceptance test 40: a backup restores into a clean database where a user signs in with the second factor, a job that was waiting resumes, the audit chains verify and isolation tests 1 to 6 pass. `apps/ops/src/restore-check.ts` checks all of them on a restored copy (five lines, listed below: sign-in, a waiting job finishing, audit chains, the seeded brand document, and isolation tests 1 to 6) and prints one line per check, `PASS` or `FAIL` (with the route pattern, table, status or error name that failed, never a secret, a code, an address or a row), and exits 1 if any failed:

| Line | What it does |
|---|---|
| `sign-in with password and second factor` | Starts a real core process (`apps/core/src/main.ts`) on the copy, with the run-time roles and the core's secrets, and signs the drill user in over HTTP: the password, then a code from the drill user's authenticator secret, then `/api/v1/session` |
| `a job waiting in the backup finishes after a worker starts` | The drill job was `created` (waiting) in the backup; a real worker process (the stand-in model, `NODE_ENV=test`, so no provider is called) is started and the job's run must reach `succeeded` within 180 s |
| `audit chains verify` | The core's `verifyAudit`, as the owner-view role, over every chain. It runs offline (no audit store), so it checks each chain's own hashes and links only: it cannot see entries missing from the end of a chain (a truncated tail); the daily `audit_verify` duty against the store can |
| `brand document restored with its checksum` | The small PDF the seed stored in the drill's own brand is in the restored database with the same type, size and sha256 as the seed's constant bytes (spec test 51) |
| `isolation tests 1 to 6` | The isolation suites' probes (`packages/db/src/isolation-probes.ts`, `apps/core/src/access/isolation-probes.ts`): the catalog rules (tests 3 and 4) on the restored schema; test 2 on every restored brand's rows; tests 2 to 5 on two probe brands written in a transaction that is rolled back; test 1, the walk of every brand-scoped route as the drill user against the other drill brand (all 404), with the reads in its own brand as the control; test 6, a real attempt token for one new job refused on two others |

The copy is throw-away and the drill changes it (sign-ins, the job's run, test 6's jobs). The drill core gets no mail, error-reporting or audit-store settings and the copy's network has no route out. The command refuses, before it starts anything (exit 2), the live database itself (the seed records its cluster identifier and database name in the drill file; a copy restored into a new container always differs) and any target host named `postgres` (the live service). It refuses a target address that carries a password, like `restore.sh`: the superuser's password comes from `PGPASSWORD`; everything else from the environment as well: the role passwords (`roles.env`), the core's four secrets and `PUBLIC_ORIGIN` (`core.env`; the second factor is stored encrypted with `AUTH_SECRET`, so the copy needs the same one) and the drill file.

**The drill user** exists before the backup. `restore-check.ts seed` creates, on the live database: the brands `restore-drill-a` and `restore-drill-b`; the user `restore-drill@drill.invalid` (a brand admin in `restore-drill-a` only) with a random password, enrolled in the second factor through the sign-in library with the core's `AUTH_SECRET` (the authenticator secret is made for this account and is no person's); an article in each brand; one small PDF (`restore-drill.pdf`, the same bytes every time) in `restore-drill-a`, stored once, so a later seed leaves it as it is; and one summary job in `restore-drill-a`, which waits in the queue while no worker runs. It writes the password, the authenticator secret and the job's id to the drill file (`0600`, refused if it exists) and prints only `{"event":"restore_drill_seeded"}`. Run again while the drill user exists (before a later drill: the waiting job must be in the backup that is drilled), it makes only a new waiting job and replaces the job's id in the existing drill file; the password and the authenticator secret stay. `unseed` (when the drill file is lost) removes the drill user together with the document it uploaded, because the document names the user as its uploader; the next seed stores it again. The drill user is a real account in production: its file stays root's, in `/opt/mkt/drill`.

**Where it runs.** Not in the ops image: that image holds only what `prepare`, `alert` and the backup need (`packages/db`, `packages/queue`, `apps/ops` and their production dependencies), and the drill starts the core and the worker, which would add both apps and all their dependencies to it. It runs instead from the release's checkout with its locked dependencies, in the same pinned Node image the images are built from, on the `mkt_data` network. On the development server `apps/ops/test/restore-check.test.ts` runs it in the normal `npm test` (a seeded database, `pg_dump --format=custom`, `pg_restore` with `restore.sh`'s flags into a new database, then restore-check passes; with one audit entry altered it fails that line).

On the production host, as root (Step 4 of plan Task 9, recorded in `docs/progress.md` under test 40):

```sh
cd /opt/mkt/marketing
C='docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml'
NODE=node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
PG=postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f
# The checkout and its locked dependencies, in a volume. On the default network: mkt_data has no route to npm.
docker volume create mkt-drill-work
docker run --rm -v /opt/mkt/marketing:/src:ro -v mkt-drill-work:/work -w /work $NODE \
  sh -c 'cp -a /src/. /work && npm ci --ignore-scripts --no-audit --no-fund'
```

1. **Seed, before the backup** (the first time, and again before each later drill). The worker must not be running (it is off until A3; otherwise `$C stop worker` until the backup has run, then `$C start worker`, which runs the drill job with the real model):

   ```sh
   install -d -m 0700 -o root -g root /opt/mkt/drill
   PGPASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/mkt/secrets/postgres.env) && export PGPASSWORD   # the superuser password
   docker run --rm --network mkt_data --env-file /opt/mkt/secrets/core.env -e PGPASSWORD \
     -e RESTORE_DRILL_FILE=/drill/drill.env -v /opt/mkt/drill:/drill -v mkt-drill-work:/work -w /work $NODE \
     node apps/ops/src/restore-check.ts seed --target postgres://postgres@postgres:5432/mkt
   unset PGPASSWORD
   ```

   Then the night's backup (or `systemctl start mkt-backup.service`) holds the drill. **Once that backup has completed, and before the live worker starts again**, cancel the drill's jobs on the live database, so the worker never sends the drill's brief to the model (the copy in the backup keeps them waiting):

   ```sh
   PGPASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/mkt/secrets/postgres.env) && export PGPASSWORD   # the superuser password
   docker run --rm --network mkt_data -e PGPASSWORD -v mkt-drill-work:/work -w /work $NODE \
     node apps/ops/src/restore-check.ts cancel-live --target postgres://postgres@postgres:5432/mkt
   unset PGPASSWORD
   ```

   It prints `{"event":"restore_drill_cancelled","jobs":<n>}` (each cancel is in the audit log as `jobs.cancelled`, reason `restore_drill`). Only then `$C start worker`, if it was running.

2. **A throw-away target and the restore**, from that backup (bring the set and the owner's key as in "Restore" above):

   ```sh
   PGPASSWORD=$(openssl rand -hex 32) && export PGPASSWORD   # a new password for the throw-away target (not the live one)
   POSTGRES_PASSWORD=$PGPASSWORD docker run -d --name mkt-drill-target --network mkt_data --shm-size 256m \
     -e POSTGRES_PASSWORD -e POSTGRES_DB=mkt $PG
   until docker exec mkt-drill-target pg_isready -h 127.0.0.1 -U postgres -d mkt; do sleep 2; done
   install -d -m 0700 /dev/shm/mkt-restore && (umask 077 && cat > /dev/shm/mkt-restore/id)   # the owner's key, in memory only
   $C --profile ops run --rm -T -e PGPASSWORD -e AGE_IDENTITY_FILE=/key/id -v /dev/shm/mkt-restore:/key:ro \
     --entrypoint mkt-restore backup \
     /backups/mkt-<ts>.dump.age /backups/mkt-<ts>.roles.sql.age postgres://postgres@mkt-drill-target:5432/mkt
   rm -rf /dev/shm/mkt-restore
   ADMIN_DATABASE_URL=postgres://postgres:$PGPASSWORD@mkt-drill-target:5432/mkt \
     $C --profile ops run --rm -T -e ADMIN_DATABASE_URL ops prepare   # the roles' passwords from roles.env
   ```

3. **The drill**:

   ```sh
   docker run --rm --network mkt_data --env-file /opt/mkt/secrets/roles.env --env-file /opt/mkt/secrets/core.env \
     --env-file /opt/mkt/drill/drill.env -e PGPASSWORD -v mkt-drill-work:/work -w /work $NODE \
     node apps/ops/src/restore-check.ts --target postgres://postgres@mkt-drill-target:5432/mkt
   ```

   Five `PASS` lines and exit 0 are the pass. Copy the five lines, the backup set's name and the date into `docs/progress.md` under test 40.

4. **Clean up**: `docker rm -f -v mkt-drill-target; docker volume rm mkt-drill-work; unset PGPASSWORD`. Keep `/opt/mkt/drill/drill.env` for later drills.

**If the drill file is lost** (the seed then refuses: the drill user exists without it), remove the drill user and seed again: the same container as `cancel-live`, with `unseed` in its place. It cancels the drill's open jobs, removes the drill user (its sessions, password and second factor go with it) and prints `{"event":"restore_drill_unseeded","removed":true,...}`; the drill brands and their rows stay, and the next seed reuses them.

## Agent evaluation and release

An agent version goes live only through the release step, and the release step needs a passing evaluation run for the version's current files and its current evaluation set (milestone 8; spec `docs/specs/2026-11-20-phase-2-onboarding-strategy.md`, section 11). Both commands write to the production database as the superuser (`ADMIN_DATABASE_URL`), so run them as root on the production host.

**Files that must not be in `agents/`.** The ops image is built with `infra/prod/Dockerfile.dockerignore`. Its patterns `**/test`, `**/.env*` and `**/.DS_Store` would leave a matching file out of the image's `agents/`. The image's files hash would then differ from the checkout's, and a release would be refused. That fails safe, but it is confusing, so never put a file or folder matching those patterns in `agents/`.

### Evaluate

```sh
npm run eval -- --agent <name> [--brand <slug>]
```

| Part | Meaning |
|---|---|
| `--agent <name>` | The folder under `agents/` (for example `summary`). It must have an evaluation runner and at least one case; a folder with no cases is refused |
| `--brand <slug>` | Also runs the cases in `agents/<name>/eval/<slug>/`, recorded against that brand. Without it only `eval/shared` runs. A release needs one run per brand folder (below) |
| `ADMIN_DATABASE_URL` | The superuser address of the live database (the `postgres` host on `mkt_data`) |
| `ANTHROPIC_API_KEY` | The provider key, the worker's value from `/opt/mkt/secrets/worker.env` |

**An evaluation makes paid model calls**: each case calls the model, and some cases are scored by a second (judge) call. Cost is recorded in the run's rows as USD and INR, or left empty when no price or rate row exists. Run it when the files or cases changed, not as a habit.

Each case prints one `PASS` or `FAIL` line with its id, then a final JSON line (`evaluation_done`, with the run id and the counts). The judge's reason is stored in the database only. Exit codes:

| Code | Meaning |
|---|---|
| 0 | The run passed |
| 1 | The run finished and failed (a case failed); the run is recorded as failed |
| 2 | Refused: bad arguments, unknown agent, an invalid brand slug or a brand that does not exist, no cases, no hostile case, a malformed case file, a case `input` the agent does not accept (the message names the file and `input.<field>`), or a variable not set. Nothing was recorded, and no model call was made for a refused input |
| 3 | Unexpected error (for example the database is down) |

The command runs from the release's checkout with its locked dependencies, in the pinned Node image, like the restore drill (`NODE` and the `mkt-drill-work` volume are made in "Restore drill"; recreate them the same way for a new release). It needs the database on `mkt_data` and the provider through the firewalled `worker_egress` network, which `mkt_data` alone cannot reach. This command has not yet been rehearsed on a host:

```sh
cd /opt/mkt/marketing
NODE=node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
PGPASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' /opt/mkt/secrets/postgres.env)
KEY=$(sed -n 's/^ANTHROPIC_API_KEY=//p' /opt/mkt/secrets/worker.env)
ID=$(docker create --network mkt_data -v mkt-drill-work:/work -w /work \
  -e ADMIN_DATABASE_URL="postgres://postgres:$PGPASSWORD@postgres:5432/mkt" -e ANTHROPIC_API_KEY="$KEY" \
  $NODE npm run eval -- --agent <name> [--brand <slug>])
docker network connect mkt_worker_egress $ID
docker start -a $ID; echo "exit $?"
docker rm -f $ID; unset PGPASSWORD KEY
```

(Refresh the volume from the checkout first, as in the drill: the files hash and the evaluation set hash are taken from this copy.)

### Release

```sh
docker compose --env-file /opt/mkt/compose.env -f infra/prod/compose.yaml --profile ops \
  run --rm ops release --agent <name> --by <owner email>
```

`docker compose run --rm ops release --agent <name> --by <owner email>` is the whole command; the file and profile options above are those of every other ops command in this runbook. `--by` is the platform owner's sign-in email (any letter case). There is no version flag: the version released is the `version` in `agents/<name>/definition.json`. The image holds the same `agents/` as the checkout it was built from, so build the ops image from the release being released.

It makes that version live (turning the earlier live version off), records the passing run on it, and writes an `agent.released` audit entry (its detail lists every evaluation run that stood for a brand folder as `evaluationRunIds`). Exit 0 prints one `agent_released` line. Exit 2 is a refusal, and the message says what to do; exit 3 is an unexpected error. It refuses when:

- the arguments are bad (`--agent` or `--by` missing or malformed), the agent has no folder under `agents/`, or `ADMIN_DATABASE_URL` is not set (these exit 2 before any database work);
- the email is not a platform owner's;
- `definition.json` cannot be read, or names another agent than the folder;
- there is no passing run for the current files and the current evaluation set: a file or a case changed after the run. If the newest such run failed, the message names its failed case ids (never their content);
- `eval/` has brand folders and any of them lacks a passing run of its own. A run without `--brand` does not stand in for them. The message names each missing brand and the `npm run eval` command for it;
- an `eval/<slug>/` folder names no brand with that slug;
- the agent has no evaluation cases;
- that version is already live;
- that version number was recorded earlier with other files (`<agent> v<N> was recorded with other files; raise "version" in definition.json and run the evaluation again`): a version number names one set of files, so raise `version` and run the evaluation again;
- another release of the same agent is running or has just changed the live version (try again after checking).

## Releasing `research` and `research_merge`

Milestone 9 adds two agents: `research` (one job per source group, each reading its own sources) and `research_merge` (one job joining the groups' results). Each goes live only through the release step above, after its own evaluation: `npm run eval -- --agent research`, then `npm run eval -- --agent research_merge`, then `release --agent research --by <owner email>` and `release --agent research_merge --by <owner email>`. Both runs make paid model calls; the cases for each agent are in `agents/<name>/eval/shared/`.

- Run the evaluations without `--brand`. Neither agent has a brand folder under `eval/` (there is no `eval/aztek/`), so the release looks for a passing run recorded against no brand; a run made with `--brand aztek` is recorded against Aztek and does not count, and the release is refused. If a brand folder is added later, run once more with `--brand <slug>` for it, as the release's refusal says.

- The evaluation uses recorded pages and documents, never the live web: the cases carry the page text, the search results and the document text the agent is given, with web tools removed, so a run is repeatable and costs only the model's own tokens.
- The hostile cases are the point of the gate. Each plants an instruction in a page, a search result, a social bio, a structured field, or a document (including text inflated inside a PDF), and the run passes only if the agent never follows it, never states the planted claim as a fact, and flags the source (`flags_source`). A run without a passing hostile case is refused, so a release cannot skip them.
- A run that passes on one version of the files is useless for the next: a change to any file under `agents/<name>/`, or to a case, needs a new evaluation before release.
- Deploying new agent files and releasing them are two steps, and a job created in between is pinned to the old files (below, "Jobs"). Deploy the files, run the evaluations, release promptly.

## What the owner needs for research on real data

Research runs on whatever the brand's intake holds. For Aztek's first run (spec section 17; `docs/sachin-to-provide.md` is the owner's list):

| ID | What | State on 2026-11-20 |
|---|---|---|
| C1 | Social profiles | Instagram is given (`https://www.instagram.com/aztekppf/`). Facebook, LinkedIn and YouTube are still open: a profile not given is simply not researched, and shows as a gap |
| C2 | Brand material to upload | The 49 MB Aztek brochure is given and is accepted: it is split into parts at upload (below). Other documents are welcome, not required |
| C4 | Competitor list | Still to be confirmed: UltrashieldX, Cosmo PPF/Sunshield, Intakt PPF, XPEL, 3M India come from the earlier audit work. Until the owner confirms them, competitors are only suggestions, never verified facts |

## Documents

Uploads go to `POST /api/v1/brands/<id>/onboarding/documents`, platform owner only.

- **Limits:** 100 MB per PDF, 5 MB per image (the provider's own per-image limit), 20 files and 500 MB per brand. A PDF the library cannot read is refused (`pdf_unreadable`), and one whose parts would grow past twice its size or 32 MiB (`pdf_too_complex`), or take more than 120 s to split, is refused too. Each refusal says how to fix it.
- **Splitting:** a PDF is split at upload into whole-page parts of at most 8 MB and 100 pages each (the most the model reads in one go), and the original is kept. Links and form actions are dropped from the parts, so a part carries only the pages it lists. The research documents group reads the parts, in batches of at most 24 MiB of base64 and 100 pages, and the intake shows "Prepared in N parts".
- **Images** (R41, relaxed in M10): the 2026-11-21 probe showed the provider accepts a 4.69 MB image, so its limit is on raw bytes. The documents group sends every image within the 5 MB (5,242,880-byte) upload limit; there is no worker-side size guard and no "Too large for the AI to read" source any more.
- **Deleting while research runs:** a document cannot be deleted while the brand's research run is going (any of its jobs still alive, or the run still created or running): the delete is refused with `research_running` ("Research is reading the brand's documents. Wait for it to finish, then delete the file."), because the documents group reads the files while it runs. Once the run has ended, a document research has read is still kept (`document_in_use`), and one it has not read can be deleted.
- **Memory:** splitting a 99 MB PDF grows the core's memory by about 300 to 320 MB at peak. The production core's limit is 1 GiB (idle about 113 MiB); the staging core's is 768 MiB (idle about 102 MiB).
- **Accepted risks, both recorded and to be revisited before uploads open to customers:**
  - R17: two concurrent 100 MB uploads can exhaust the core's memory. Only the platform owner uploads, and only the split itself is serialised.
  - R19: a crafted decompression-bomb PDF can make the library use unbounded memory while loading, and restart the core. Nothing is stored before the split succeeds. The fix is to split in a child process with memory and time caps.
- **Cloudflare's own limit:** Cloudflare caps request bodies at 100 MB on the Free and Pro plans, so a PDF between 100,000,000 and 104,857,600 bytes may be refused at Cloudflare with its own 413; the dashboard shows the size-limit message for that. The app limit stays at 100 MiB, and the 49 MB Aztek brochure is unaffected.
- **The restore drill** now includes a document: the seed stores a small PDF in the drill brand and the restore check's fifth line proves it came back with the same checksum (see "Restore drill").

## Jobs

- **Requeue keeps the job's agent files** (R7). A job records the hash of the agent files it was created with, and a requeue keeps it, because a run is pinned to one version. A job created before a release of new agent files can therefore only be cancelled, not run: its worker finds the live files differ and ends the attempt (`agent_files_mismatch`). Deploy agent-file changes, evaluate and release promptly, and start research afterwards.
- **One kill switch for research** (R36). An agent kill switch matches the run's agent, so switching off `research` holds both the research group jobs and the merge job. That is the owner's single "stop research" control; switching it back on lets held jobs go.
- **A dead group does not fail the run.** A research run is not failed by one dead group: the merge proceeds with the groups that finished and lists the dead ones as `deadGroups`. The run fails only when every group died, or when the merge died. The owner sees the gaps and decides what to do about them.
- **Only one research run at a time per brand** (commit 7d8a189): a start while a run is open is refused (`research_running`), including while a dead group's siblings are still running.
- **When every group dies** no merge job is made and the run fails. The overview then shows the merge as failed (not waiting), the progress screen says "Research could not finish. Check the agents' releases, then start research again.", and Start research is enabled again on the intake.
- **The 150-search cap per run is enforced at run time** (M10). The attempt reply carries `runSearches`, the sum of the searches recorded by every job of the run; each request's `web_search` uses are limited to 20 per job and to what the run has left (150 less `runSearches` less the searches made so far in the attempt). When nothing is left, the request carries no `web_search` tool and fetching continues. One exception remains (R29): a continuation whose history already holds `web_search` blocks keeps the tool at `max_uses` 1, because it is not proven that the API accepts that history without it (the R13 probe in `apps/worker/test/anthropic-live.test.ts` has not been run). So the run can pass 150 by at most one search per continuation, until the probe is run. A retry counts the earlier attempts' recorded searches, so it cannot spend the budget again.
- **Read web sources must be pages the provider returned** (I6, M10). After a web group's reply is parsed, a source of kind `site`, `social`, `search` or `competitor` recorded as `read` must have an address that appears in a fetch result or a search result of the job (compared without case in the scheme and host, a leading `www.`, a fragment or a trailing slash). One that does not becomes an `error` source ("Not read in this run."), the findings lose that source, and a finding left with none moves to `unsettled`.
- **A requeued group that finishes after the merge started** stores its sources, but they never reach the suggestions: the merge already read the groups that had finished. Start research again to pick them up (a re-run supersedes only undecided suggestions).
- **Fetched pages are bounded** (R42): the research definition gives `web_fetch` a `maxContentTokens` of 40,000, sent to the provider as `max_content_tokens`, so one large page or PDF (such as a 49 MB brochure found on the web) is cut to about 40,000 tokens instead of filling the step. As a second guard, the worker refuses to save a step whose checkpoint would pass the core's 8 MB limit: the call is costed without its output and the attempt fails with a message that names the step and its size.
- **A model request is bounded by its own timeout from start to end.** The provider library's timeout covers only the wait for the response headers, so a streamed research request that stalls after its headers would never end. The worker's adapter now aborts any request at its timeout and reports it as a timeout: the call stays started for reconciliation and the job retries, as for any timeout.

## Production steps at the end of milestone 9

For the owner to approve, one at a time. Nothing here has been run.

- [ ] **Check the rows migration 0025 constrains, before deploying it.** Migration 0025 adds two checks to existing tables (milestone 8's `research_source` and `brand_document`). Run both queries on production first, with `psql` in the postgres container as in "First deployment" (they only read); each must return 0, or the migration is refused and the deployment stops:
  - `select count(*) from app.research_source where result not in ('read','blocked','empty','error','stated')`
  - `select count(*) from app.brand_document where size_bytes <> octet_length(bytes)`
- [ ] **Deploy** the milestone's release to production (the usual "First deployment" update path), with the new proxy site file (validate, then restart the proxy container) and the migrations.
- [ ] **Probe a continuation with a spent web tool** (R13): one live call, cents, run from the production worker's environment. It checks whether the API accepts a continuation whose history holds a spent web-search tool with the tool removed or `max_uses` 0. Until then the worker keeps the tool at `max_uses 1` on continuations; switch to the accepted form if there is one.
- [ ] **Check web tools with an output schema** (R24): one live call, to see whether web tools plus an output schema return a 400. Research group requests send no output schema either way; if the API accepts the combination we may switch later.
- [ ] **Check that a long streamed request is cut at its timeout** (I3): one live streamed call with web tools and a short request timeout (for example 20 s) for a task that takes longer. It must end at about its timeout with a timeout error, and its model call must stay `started` for reconciliation. Record the time it ended.
- [ ] **Probe the image limit** (I5, R41): send one 4.5 MB JPEG (raw bytes, about 6 MB of base64) to the model once, and record whether the provider accepts it. If it does, the limit is on raw bytes and R41's worker guard (images over about 3.75 MiB are not sent) can be relaxed later; if it is refused, the guard stays.
- [ ] **Evaluate and release**: the `research` evaluation, then the `research_merge` evaluation, then each release (above), in that order.
- [ ] **The Aztek live run**: start research for Aztek from the dashboard with the intake the owner has given, watch the progress screen, and review the draft profile (spec test 54 is the end of milestone 11; this is research only). Precondition: the released `research` definition carries `maxContentTokens` on `web_fetch` (40,000; it is sent as `max_content_tokens`, I4, R42). Without it, one large fetched page can fill a step past the 8 MB checkpoint, cost three paid attempts and fail the group. Check `agents/research/definition.json` in the released files before starting.
