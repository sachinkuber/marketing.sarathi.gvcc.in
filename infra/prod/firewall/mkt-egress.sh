#!/bin/bash
# The worker's egress firewall (plan M7, ruling R9). The worker's only way out is the compose network
# worker_egress, whose bridge is named mkt-egress0 unless MKT_EGRESS_BRIDGE says otherwise (infra/prod/compose.yaml
# uses the same variable and default). From that bridge it allows
# TCP 443 to public addresses only: no other port, no private, shared, loopback, link-local, multicast or reserved
# range, and not the host itself. DNS is allowed to the host's resolvers only.
# This is wider than plan decision 3 ("the model provider only"), a deviation awaiting the owner's approval
# (ruling R15, docs/operations.md).
#
# Keyed on the bridge's name, not its subnet, so the rules can be installed before the network exists: the
# systemd unit mkt-egress.service runs `install` before Docker starts, at every boot. Docker keeps what is in its
# DOCKER-USER chain (it creates the chain only when it is missing).
#
# Usage, as root, installed as /opt/mkt/firewall/mkt-egress.sh:
#   mkt-egress.sh install   (idempotent) add or refresh the rules
#   mkt-egress.sh check     verify the rules, the backend, and the network (after `up -d`)
# Environment (the unit reads it from /opt/mkt/compose.env, the file the compose commands use too):
#   MKT_EGRESS_BRIDGE    the bridge name (default mkt-egress0), the same as in compose.yaml.
#   MKT_EGRESS_DNS       "a.b.c.d ..." the resolvers to allow. Unset: read from MKT_EGRESS_RESOLV_CONF (default
#                        /run/systemd/resolve/resolv.conf, else /etc/resolv.conf), waiting up to
#                        MKT_EGRESS_DNS_WAIT seconds (default 60) for a resolver to appear there at boot.
#                        Install fails when no resolver is found: the worker could not resolve anything.
#   MKT_EGRESS_DRY_RUN=1 print each iptables command instead of running it (infra/prod/test/firewall.test.mjs).
# A re-run builds the new rules in the other of two chains (MKT-EGRESS-A, MKT-EGRESS-B), points the jump at it,
# and only then removes the old chain, so the bridge is never left without rules.
set -euo pipefail

BRIDGE=${MKT_EGRESS_BRIDGE:-mkt-egress0}
NETWORK=mkt_worker_egress
DAEMON_JSON=${MKT_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}
BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"

fail() {
  echo "mkt-egress: $*" >&2
  exit 1
}

dry() { [ -n "${MKT_EGRESS_DRY_RUN:-}" ]; }

ipt() {
  if dry; then echo "iptables $*"; else iptables "$@"; fi
}

# Docker's own nftables backend has no DOCKER-USER chain: rules here would silently not apply.
check_backend() {
  if grep -qsE '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' "$DAEMON_JSON"; then
    fail "Docker is set to its nftables firewall backend ($DAEMON_JSON): DOCKER-USER does not exist and these rules would not apply. Stop and ask."
  fi
}

read_resolvers() {
  local file=${MKT_EGRESS_RESOLV_CONF:-/run/systemd/resolve/resolv.conf}
  [ -r "$file" ] || file=/etc/resolv.conf
  # IPv4 resolvers only, loopback excluded (a container cannot use the host's stub resolver, 127.0.0.53).
  awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 !~ /^127\./ { print $2 }' "$file" 2>/dev/null || true
}

resolvers() {
  if [ -n "${MKT_EGRESS_DNS+x}" ]; then
    echo "$MKT_EGRESS_DNS" | tr ' ' '\n' | sed '/^$/d'
    return
  fi
  local found waited=0
  found=$(read_resolvers)
  # At boot systemd-resolved may not have written its file, or learnt the upstream servers, yet.
  while [ -z "$found" ] && [ "$waited" -lt "${MKT_EGRESS_DNS_WAIT:-60}" ]; do
    sleep 1
    waited=$((waited + 1))
    found=$(read_resolvers)
  done
  echo "$found"
}

# The chain the first matching jump in DOCKER-USER points at, if any.
current_chain() {
  dry && return 0
  # No DOCKER-USER chain yet (first boot, before Docker ever ran): no current chain.
  { iptables -S DOCKER-USER 2>/dev/null || true; } |
    sed -n "s/^-A DOCKER-USER -i $BRIDGE -j \(MKT-EGRESS-[AB]\)\$/\1/p" | head -1
}

install() {
  check_backend
  local dns
  dns=$(resolvers)
  [ -n "$dns" ] ||
    fail "no DNS resolver found (only a loopback stub, or none); set MKT_EGRESS_DNS in /opt/mkt/compose.env to the host's upstream resolvers. Nothing was changed."
  local old new
  old=$(current_chain)
  if [ "$old" = MKT-EGRESS-A ]; then new=MKT-EGRESS-B; else new=MKT-EGRESS-A; fi
  if ! dry; then
    iptables -n -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
    # A leftover chain of that name from an interrupted run: unhook and remove it first.
    if iptables -n -L "$new" >/dev/null 2>&1; then
      unhook "$new"
      iptables -F "$new"
      iptables -X "$new"
    fi
  fi
  ipt -N "$new"
  ipt -A "$new" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  # DNS first: cloud resolvers often sit in 10/8 or 169.254/16, which are dropped just below.
  for resolver in $dns; do
    ipt -A "$new" -d "$resolver/32" -p udp --dport 53 -j RETURN
    ipt -A "$new" -d "$resolver/32" -p tcp --dport 53 -j RETURN
  done
  for net in $BLOCKED; do
    ipt -A "$new" -d "$net" -j DROP
  done
  # The host's own addresses (its published ports are translated to container addresses, dropped above).
  ipt -A "$new" -m addrtype --dst-type LOCAL -j DROP
  ipt -A "$new" -p tcp --dport 443 -j RETURN
  ipt -A "$new" -j DROP
  # Point the bridge at the new chain, then retire the old one.
  ipt -I DOCKER-USER 1 -i "$BRIDGE" -j "$new"
  if [ -n "$old" ]; then
    unhook "$old"
    iptables -F "$old"
    iptables -X "$old"
  fi
  # Anything from the bridge to the host's own services.
  if dry || ! iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null; then
    ipt -I INPUT 1 -i "$BRIDGE" -j DROP
  fi
  echo "mkt-egress: installed $new for $BRIDGE (DNS: $(echo $dns))"
}

# Remove every DOCKER-USER jump from the bridge to a chain.
unhook() {
  local count i
  count=$({ iptables -S DOCKER-USER 2>/dev/null || true; } | grep -cxF -- "-A DOCKER-USER -i $BRIDGE -j $1" || true)
  for ((i = 0; i < count; i++)); do iptables -D DOCKER-USER -i "$BRIDGE" -j "$1"; done
}

check() {
  check_backend
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || fail "no DOCKER-USER chain"
  local first chain
  first=$(iptables -S DOCKER-USER | sed -n 2p)
  chain=$(echo "$first" | sed -n "s/^-A DOCKER-USER -i $BRIDGE -j \(MKT-EGRESS-[AB]\)\$/\1/p")
  [ -n "$chain" ] || fail "the first DOCKER-USER rule is not the jump for $BRIDGE (run install)"
  iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || fail "no INPUT drop for $BRIDGE"
  iptables -S "$chain" | grep -qE -- '--dport 53 -j RETURN$' ||
    fail "$chain allows no DNS resolver: the worker cannot resolve names (set MKT_EGRESS_DNS, run install)"
  iptables -C "$chain" -p tcp --dport 443 -j RETURN 2>/dev/null || fail "no 443 rule in $chain"
  [ "$(iptables -S "$chain" | tail -1)" = "-A $chain -j DROP" ] || fail "$chain does not end in DROP"
  local backend
  backend=$(docker info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null || true)
  case "$backend" in *nftables*) fail "Docker reports its nftables firewall backend" ;; esac
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NETWORK")" = "$BRIDGE" ] ||
      fail "$NETWORK is not on bridge $BRIDGE (MKT_EGRESS_BRIDGE differs between compose and this firewall?)"
    [ "$(docker network inspect -f '{{.EnableIPv6}}' "$NETWORK")" = false ] ||
      fail "$NETWORK has IPv6 enabled; these rules are IPv4 only"
  else
    echo "mkt-egress: $NETWORK does not exist yet (the rules are in place for when it does)"
  fi
  echo "mkt-egress: ok ($chain)"
}

case "${1:-}" in
  install) install ;;
  check) check ;;
  *)
    echo "usage: mkt-egress.sh install|check" >&2
    exit 64
    ;;
esac
