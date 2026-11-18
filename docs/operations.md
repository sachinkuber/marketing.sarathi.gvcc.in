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
| `infra/prod/firewall/mkt-egress.sh`, `mkt-egress.service` | The worker's egress firewall and the unit that installs it before Docker starts |

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
   docker compose -f infra/prod/compose.yaml -f infra/prod/compose.proxy-network.yaml up -d
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

`infra/prod/test/proxy.test.mjs` renders the template, has the same Caddy validate it, and runs the smoke script and the header, body and address rules through it.

### Cloudflare ranges

Cloudflare changes its ranges rarely and announces it. To refresh: fetch `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`, replace the lists in `cloudflare-ips.txt`, update its date, copy every range into the global `trusted_proxies`, validate and reload. A Cloudflare address missing from the list makes requests from it look like Cloudflare's own address (one shared limiter bucket), never like a forged one.

## First deployment

On the production host, as root, from a checkout of the release (`/opt/mkt/marketing`). Steps 1 to 4 are the order of every later deployment too (the firewall is already in place then) (migrations, then the queue, then core, worker and dashboard; the core and the worker always together).

1. **Folders and secrets.** Every value is generated on the host with `openssl rand` and goes only into these files, never onto a command line that is logged, into the repository or an image:

   ```sh
   install -d -m 0700 -o root -g root /opt/mkt /opt/mkt/secrets
   cd /opt/mkt/marketing
   for f in postgres roles core worker dashboard; do
     install -m 0600 -o root -g root infra/prod/secrets.example/$f.env.example /opt/mkt/secrets/$f.env
   done
   ```

   Then edit each file and replace every `CHANGE_ME` with its own `openssl rand -hex 32` (hex keeps database URLs valid): the superuser password (twice in `postgres.env`), the four role passwords (`roles.env`, and the same four in the URLs of `core.env` and `worker.env`), and `AUTH_SECRET`, `WORKER_SECRET` (the same in `core.env` and `worker.env`), `ATTEMPT_TOKEN_SECRET` and `TRIGGER_SECRET`. `ANTHROPIC_API_KEY` is the provider's key (A3). Check: `ls -l /opt/mkt/secrets` shows `-rw------- root root` for every file, and `grep -l CHANGE_ME /opt/mkt/secrets/*.env` prints nothing (the core and the worker refuse to start otherwise). Leave `MKT_SECRETS` unset: it exists only for the tests, and unset the stack reads `/opt/mkt/secrets`.

2. **Build**, the `ops` image included (without `--profile ops` it is not rebuilt, and step 3 would run the old migrations). One image at a time on a shared host:

   ```sh
   for s in core worker dashboard ops; do docker compose -f infra/prod/compose.yaml --profile ops build "$s"; done
   ```

3. **Prepare** the database (migrations, run-time role passwords, the queue): `docker compose -f infra/prod/compose.yaml --profile ops run --rm ops prepare`. Its last line is JSON with `"event":"prepared"`.

4. **Worker egress firewall**, installed before the stack first starts (below). Then **start**: `docker compose -f infra/prod/compose.yaml up -d` (add `-f infra/prod/compose.proxy-network.yaml` in case 2 above). Then `docker compose -f infra/prod/compose.yaml ps` shows postgres, core, worker and dashboard healthy, `curl -fsS http://127.0.0.1:4100/api/health/ready` answers `{"status":"ok"}`, and `/opt/mkt/firewall/mkt-egress.sh check` prints `mkt-egress: ok`.

5. **Dashboard file permissions.** After the first start, `docker compose -f infra/prod/compose.yaml logs dashboard | grep -i eacces` must print nothing: an `EACCES` on `.next` means the image's cache folder is not writable by the `node` user.

6. **Worker egress check** from inside the worker (below, "Check").

7. **Proxy site** (above): render, validate, reload.

8. **Model prices and a first exchange rate**, before the first real model call (until then every call succeeds uncosted and is listed for reconciliation). As the database superuser, with the owner's figures (micro-dollars per million tokens; the rate in micro-rupees per dollar, e.g. 83500000 for 83.5):

   ```sh
   docker compose -f infra/prod/compose.yaml exec -T postgres psql -U postgres -d mkt -v ON_ERROR_STOP=1 <<'SQL'
   insert into app.model_price (model, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, source)
   values ('<model>', current_date, <input>, <output>, <cache_read>, <cache_write>, 'owner');
   select app.record_fx_rate(current_date, <rate_micros>, 'owner');
   SQL
   ```

9. **Bootstrap**, run by the owner (A9) with the superuser's address in the environment only, never on the command line. The temporary password is printed once, to the owner's terminal:

   ```sh
   read -rs BOOTSTRAP_DATABASE_URL && export BOOTSTRAP_DATABASE_URL   # postgres://postgres:<password>@postgres:5432/mkt
   docker compose -f infra/prod/compose.yaml exec -T -e BOOTSTRAP_DATABASE_URL core \
     node apps/core/src/bootstrap.ts --owner-email <owner's email>
   unset BOOTSTRAP_DATABASE_URL
   ```

10. **Smoke check** (below). Every check passes.

## Worker egress firewall

The worker's only way out is the network `mkt_worker_egress`, an ordinary bridge (ruling R9). Compose gives it a fixed bridge name, `mkt-egress0`, a fixed subnet, `10.247.73.0/24`, and no IPv6. `infra/prod/firewall/mkt-egress.sh` limits traffic from that bridge to:

- replies to connections already made;
- DNS (UDP and TCP 53) to the host's resolvers only, read from `/run/systemd/resolve/resolv.conf` or `/etc/resolv.conf` (or named in `MKT_EGRESS_DNS`). These come first, because cloud resolvers often sit in 10/8 or 169.254/16;
- then it drops every private, shared, loopback, link-local, multicast and reserved range, and the host's own addresses (`DOCKER-USER`, plus a DROP in `INPUT` for the host's services);
- then it allows TCP 443 and drops everything else.

**Deviation awaiting the owner's approval (ruling R15).** Plan decision 3 says the worker reaches "the model provider only". This firewall enforces TCP 443 to any public address, which is wider. It does not try to follow the provider's address ranges. Until the owner accepts this, or asks for a provider-only rule (for example an egress proxy with a host allow-list), the plan's rule is not met.

The rules are keyed on the bridge's name, not on its subnet, so they can be in place before the network exists. A systemd unit installs them at every boot **before Docker starts**, so the worker never runs unrestricted: Docker restarts the containers as soon as it starts, and it keeps what is in `DOCKER-USER`. On the production host, before the first `up -d`:

```sh
install -d -m 0755 /opt/mkt/firewall
install -m 0755 infra/prod/firewall/mkt-egress.sh /opt/mkt/firewall/mkt-egress.sh
install -m 0644 infra/prod/firewall/mkt-egress.service /etc/systemd/system/mkt-egress.service
systemctl daemon-reload
systemctl enable --now mkt-egress.service
```

The script refuses loudly if Docker is set to its own nftables firewall backend (`"firewall-backend": "nftables"` in `/etc/docker/daemon.json`; `docker info` shows it as `FirewallBackend`), because then there is no `DOCKER-USER` chain and the rules would not apply. Stop and ask in that case. Re-run `systemctl restart mkt-egress.service` after the resolvers change. The `iptables` here is whichever variant the host's Docker uses (legacy or nft); `infra/prod/test/firewall.test.mjs` checks the rule order.

If `10.247.73.0/24` is already used on the host or its network (`ip route`, `docker network inspect`), set another unused private /24 in `MKT_EGRESS_SUBNET`, in the environment of every `docker compose` command (for example in `/opt/mkt/compose.env`, sourced first). Nothing in the firewall changes, because it matches the bridge name.

### Check

After `up -d`, run each command below:

```sh
/opt/mkt/firewall/mkt-egress.sh check            # mkt-egress: ok  (backend, rule order, bridge name, IPv6 off)
W='docker compose -f infra/prod/compose.yaml exec -T worker node -e'
$W "fetch('https://api.anthropic.com/').then(r=>console.log('443 ok',r.status),e=>console.log('443 blocked',e.cause?.code))"   # 443 ok
$W "fetch('http://example.com/').then(r=>console.log('80 open',r.status),e=>console.log('80 blocked',e.cause?.code))"           # 80 blocked
HOST_IP=$(hostname -I | cut -d' ' -f1)
$W "fetch('https://$HOST_IP/',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('host open'),e=>console.log('host blocked'))"  # host blocked
```

## Smoke check

`node infra/prod/smoke.mjs <origin>` checks: `/api/health/ready` and `/api/health/worker` answer 200; `/` answers 200 with the app's security headers and the proxy's HSTS and COOP; `/api/v1/session` without a cookie answers 401; a trigger with a query string is refused by the core (`trigger_refused`); a DELETE body reaches the core; a 900 kB checkpoint body is not refused by the proxy; and, sent to the origin server directly (not through Cloudflare) with forged `CF-Connecting-IP` and `X-Forwarded-For`, both the invite limiter and the sign-in limiter limit by the real address. One line per check; exit 0 when all pass, 1 when one fails, 2 when some were skipped. It prints statuses and error codes only. Its options are in the script's header.

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
