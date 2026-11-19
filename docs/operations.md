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

To be recorded when the owner gives access (A1), with the same commands, read-only: `nproc`, `free -h`, `swapon --show`, `df -h /`, `uptime`, `docker version`, `docker compose version`, `docker ps`, the proxy and its configuration, how TLS is issued, and n8n's container and limits (`docker inspect <n8n> --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'`). The test 41 figures in spec section 17 are then corrected from these facts, as a change for the owner to approve.

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

The rules (plan decisions 1 and 2; the proxy preconditions of milestones 2b, 2c, 4 and 6 in `docs/progress.md`) are written in the template's header. In short: `/api/` to the core, everything else to the dashboard; path, query string, Host, `Authorization`, the `X-Mkt-*` headers, the raw body and DELETE bodies unchanged; bodies up to 1 MiB; HSTS and COOP added; `X-Forwarded-For` replaced (never appended) with the client's address, which is believed from `CF-Connecting-IP` only when the request comes from a Cloudflare address.

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

`infra/prod/test/proxy.test.mjs` renders the template, has the same Caddy validate it, and runs the smoke script and the header, body and address rules through it.

### Cloudflare ranges

Cloudflare changes its ranges rarely and announces it. To refresh: fetch `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`, replace the lists in `cloudflare-ips.txt`, update its date, copy every range into the global `trusted_proxies`, validate and reload. A Cloudflare address missing from the list makes requests from it look like Cloudflare's own address (one shared limiter bucket), never like a forged one.

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

`node infra/prod/smoke.mjs <origin>` checks: `/api/health/ready` and `/api/health/worker` answer 200; `/` answers 200 with the app's security headers and the proxy's HSTS and COOP; `/api/v1/session` without a cookie answers 401; a trigger with a query string is refused by the core (`trigger_refused`; skipped, so exit 2, without `--trigger-secret-file`, because without the secret a dropped query string cannot be told from a kept one); a DELETE body reaches the core; a 900 kB checkpoint body is not refused by the proxy; and, sent to the origin server directly (not through Cloudflare) with forged `CF-Connecting-IP` and `X-Forwarded-For`, both the invite limiter and the sign-in limiter limit by the real address. One line per check; exit 0 when all pass, 1 when one fails, 2 when some were skipped. It prints statuses and error codes only. Its options are in the script's header.

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

Acceptance test 40: a backup restores into a clean database where a user signs in with the second factor, a job that was waiting resumes, the audit chains verify and isolation tests 1 to 6 pass. `apps/ops/src/restore-check.ts` checks all four on a restored copy and prints one line per check, `PASS` or `FAIL` (with the route pattern, table, status or error name that failed, never a secret, a code, an address or a row), and exits 1 if any failed:

| Line | What it does |
|---|---|
| `sign-in with password and second factor` | Starts a real core process (`apps/core/src/main.ts`) on the copy, with the run-time roles and the core's secrets, and signs the drill user in over HTTP: the password, then a code from the drill user's authenticator secret, then `/api/v1/session` |
| `a job waiting in the backup finishes after a worker starts` | The drill job was `created` (waiting) in the backup; a real worker process (the stand-in model, `NODE_ENV=test`, so no provider is called) is started and the job's run must reach `succeeded` within 180 s |
| `audit chains verify` | The core's `verifyAudit`, as the owner-view role, over every chain. It runs offline (no audit store), so it checks each chain's own hashes and links only: it cannot see entries missing from the end of a chain (a truncated tail); the daily `audit_verify` duty against the store can |
| `isolation tests 1 to 6` | The isolation suites' probes (`packages/db/src/isolation-probes.ts`, `apps/core/src/access/isolation-probes.ts`): the catalog rules (tests 3 and 4) on the restored schema; test 2 on every restored brand's rows; tests 2 to 5 on two probe brands written in a transaction that is rolled back; test 1, the walk of every brand-scoped route as the drill user against the other drill brand (all 404), with the reads in its own brand as the control; test 6, a real attempt token for one new job refused on two others |

The copy is throw-away and the drill changes it (sign-ins, the job's run, test 6's jobs). The drill core gets no mail, error-reporting or audit-store settings and the copy's network has no route out. The command refuses, before it starts anything (exit 2), the live database itself (the seed records its cluster identifier and database name in the drill file; a copy restored into a new container always differs) and any target host named `postgres` (the live service). It refuses a target address that carries a password, like `restore.sh`: the superuser's password comes from `PGPASSWORD`; everything else from the environment as well: the role passwords (`roles.env`), the core's four secrets and `PUBLIC_ORIGIN` (`core.env`; the second factor is stored encrypted with `AUTH_SECRET`, so the copy needs the same one) and the drill file.

**The drill user** exists before the backup. `restore-check.ts seed` creates, on the live database: the brands `restore-drill-a` and `restore-drill-b`; the user `restore-drill@drill.invalid` (a brand admin in `restore-drill-a` only) with a random password, enrolled in the second factor through the sign-in library with the core's `AUTH_SECRET` (the authenticator secret is made for this account and is no person's); an article in each brand; and one summary job in `restore-drill-a`, which waits in the queue while no worker runs. It writes the password, the authenticator secret and the job's id to the drill file (`0600`, refused if it exists) and prints only `{"event":"restore_drill_seeded"}`. Run again while the drill user exists (before a later drill: the waiting job must be in the backup that is drilled), it makes only a new waiting job and replaces the job's id in the existing drill file; the password and the authenticator secret stay. The drill user is a real account in production: its file stays root's, in `/opt/mkt/drill`.

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

   Four `PASS` lines and exit 0 are the pass. Copy the four lines, the backup set's name and the date into `docs/progress.md` under test 40.

4. **Clean up**: `docker rm -f -v mkt-drill-target; docker volume rm mkt-drill-work; unset PGPASSWORD`. Keep `/opt/mkt/drill/drill.env` for later drills.

**If the drill file is lost** (the seed then refuses: the drill user exists without it), remove the drill user and seed again: the same container as `cancel-live`, with `unseed` in its place. It cancels the drill's open jobs, removes the drill user (its sessions, password and second factor go with it) and prints `{"event":"restore_drill_unseeded","removed":true,...}`; the drill brands and their rows stay, and the next seed reuses them.
