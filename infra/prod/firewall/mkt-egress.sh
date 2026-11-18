#!/bin/bash
# The egress firewall for the stack's two ways out (plan M7, rulings R9 and R19):
#   - the worker's network worker_egress, bridge mkt-egress0 unless MKT_EGRESS_BRIDGE says otherwise
#     (chains MKT-EGRESS-A/B), for the model provider;
#   - the offsite service's network backup_egress, bridge mkt-bkegress0 unless MKT_BACKUP_EGRESS_BRIDGE says
#     otherwise (chains MKT-BKEGRESS-A/B), for the off-server backup copy (owner decision 2026-11-18, R19).
# infra/prod/compose.yaml uses the same variables and defaults. From each bridge it allows TCP 443 to public
# addresses only: no other port, no private, shared, loopback, link-local, multicast or reserved range, and not
# the host itself. DNS is allowed to the host's resolvers only.
# For the worker this is wider than plan decision 3 ("the model provider only"), a deviation awaiting the owner's
# approval (ruling R15, docs/operations.md).
#
# Keyed on the bridges' names, not their subnets, so the rules can be installed before the networks exist: the
# systemd unit mkt-egress.service runs `install` before Docker starts, at every boot. Docker keeps what is in its
# DOCKER-USER chain (it creates the chain only when it is missing). Each bridge is installed on its own, with its
# own fail-closed fallback: one failing never leaves the other unprotected, and install then exits 1.
#
# Usage, as root, installed as /opt/mkt/firewall/mkt-egress.sh:
#   mkt-egress.sh install   (idempotent) add or refresh the rules, for both bridges
#   mkt-egress.sh check     verify the rules, the backend, and the networks (after `up -d`)
# Environment (the unit reads it from /opt/mkt/compose.env, the file the compose commands use too):
#   MKT_EGRESS_BRIDGE         the worker's bridge name (default mkt-egress0), the same as in compose.yaml.
#   MKT_BACKUP_EGRESS_BRIDGE  the backup upload's bridge name (default mkt-bkegress0), the same as in compose.yaml.
#   MKT_EGRESS_DNS       "a.b.c.d ..." the resolvers to allow, on both bridges. Unset: read from
#                        MKT_EGRESS_RESOLV_CONF (default /run/systemd/resolve/resolv.conf, else /etc/resolv.conf),
#                        waiting up to MKT_EGRESS_DNS_WAIT seconds (default 60) for a resolver to appear there at boot.
#                        With no resolver, install fails closed: for each bridge it keeps a chain already in place,
#                        or installs one with no DNS rule, and exits 1.
#   MKT_EGRESS_DRY_RUN=1 print each iptables command instead of running it (infra/prod/test/firewall.test.mjs).
# A re-run builds a bridge's new rules in the other of its two chains (A, B), points the jump at it, and only then
# removes the old chain, so the bridge is never left without rules.
set -euo pipefail

BRIDGE=${MKT_EGRESS_BRIDGE:-mkt-egress0}
BACKUP_BRIDGE=${MKT_BACKUP_EGRESS_BRIDGE:-mkt-bkegress0}
DAEMON_JSON=${MKT_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}
BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"

# The bridge being worked on, set by use_bridge: its name, its chains' prefix (the chains are $PREFIX-A and
# $PREFIX-B), the compose network on it, and who is behind it (for messages).
B=
PREFIX=
NETWORK=
WHO=

use_bridge() {
  case "$1" in
    worker) B=$BRIDGE PREFIX=MKT-EGRESS NETWORK=mkt_worker_egress WHO="the worker" ;;
    backup) B=$BACKUP_BRIDGE PREFIX=MKT-BKEGRESS NETWORK=mkt_backup_egress WHO="the backup upload" ;;
  esac
}

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

# The chain the first matching jump in DOCKER-USER points at for the current bridge, if any.
current_chain() {
  dry && return 0
  # No DOCKER-USER chain yet (first boot, before Docker ever ran): no current chain.
  { iptables -S DOCKER-USER 2>/dev/null || true; } |
    sed -n "s/^-A DOCKER-USER -i $B -j \($PREFIX-[AB]\)\$/\1/p" | head -1
}

# Fail closed. If install stops before the bridge points at a complete chain, and nothing else covers the bridge,
# everything from it is dropped (nothing behind it gets out at all) until an install succeeds. Docker is never
# stopped for it: other projects on the host are not affected.
INSTALLED=
fail_closed() {
  [ -n "$INSTALLED" ] && return 0
  dry && return 0
  if ! { iptables -S DOCKER-USER 2>/dev/null || true; } |
    grep -qE -- "^-A DOCKER-USER -i $B -j ($PREFIX-[AB]|DROP)\$"; then
    iptables -n -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER || true
    iptables -I DOCKER-USER 1 -i "$B" -j DROP || true
    echo "mkt-egress: install failed; everything from $B is dropped until an install succeeds" >&2
  fi
  iptables -C INPUT -i "$B" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$B" -j DROP || true
}

# Install the rules for the current bridge, with the resolvers in $1. Run in a subshell of its own (install_all),
# so its exit and its fail-closed trap concern this bridge only.
install_bridge() {
  local dns=$1 old new
  trap fail_closed EXIT
  # Anything from the bridge to the host's own services; independent of the chain, so first.
  if dry || ! iptables -C INPUT -i "$B" -j DROP 2>/dev/null; then
    ipt -I INPUT 1 -i "$B" -j DROP
  fi
  old=$(current_chain)
  if [ -z "$dns" ] && [ -n "$old" ]; then
    INSTALLED=1
    fail "no DNS resolver found (only a loopback stub, or none); the existing rules for $B ($old) are left in place. Set MKT_EGRESS_DNS in /opt/mkt/compose.env to the host's upstream resolvers and run install again."
  fi
  if [ "$old" = "$PREFIX-A" ]; then new=$PREFIX-B; else new=$PREFIX-A; fi
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
  # DNS first: cloud resolvers often sit in 10/8 or 169.254/16, which are dropped just below. With no resolver
  # (fail closed) there is no DNS rule: nothing behind the bridge can resolve, and everything but 443 stays dropped.
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
  # Point the bridge at the new chain; from here on it is covered. Then retire the old chain and any emergency
  # DROP a failed install left.
  ipt -I DOCKER-USER 1 -i "$B" -j "$new"
  INSTALLED=1
  if [ -n "$old" ]; then
    unhook "$old"
    iptables -F "$old"
    iptables -X "$old"
  fi
  dry || unhook DROP
  if [ -z "$dns" ]; then
    fail "no DNS resolver found (only a loopback stub, or none): installed $new for $B with no DNS rule (fail closed; $WHO cannot resolve names). Set MKT_EGRESS_DNS in /opt/mkt/compose.env to the host's upstream resolvers and run install again."
  fi
  echo "mkt-egress: installed $new for $B (DNS: $(echo $dns))"
}

install() {
  check_backend
  local dns which status=0
  dns=$(resolvers)
  for which in worker backup; do
    use_bridge "$which"
    # A subshell per bridge, run as a plain command (not under `if` or `||`, which would switch errexit off
    # inside it): a failure stops that bridge's install and runs its own fail-closed trap, nothing more.
    set +e
    (
      set -e
      install_bridge "$dns"
    )
    [ $? -eq 0 ] || status=1
    set -e
  done
  return "$status"
}

# Remove every DOCKER-USER jump from the current bridge to a chain.
unhook() {
  local count i
  count=$({ iptables -S DOCKER-USER 2>/dev/null || true; } | grep -cxF -- "-A DOCKER-USER -i $B -j $1" || true)
  for ((i = 0; i < count; i++)); do iptables -D DOCKER-USER -i "$B" -j "$1"; done
}

check() {
  check_backend
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || fail "no DOCKER-USER chain"
  local backend
  backend=$(docker info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null || true)
  case "$backend" in *nftables*) fail "Docker reports its nftables firewall backend" ;; esac
  # The jumps for both bridges come first in DOCKER-USER, in either order (they match different interfaces).
  local leading which chain summary=
  leading=$(iptables -S DOCKER-USER | sed 1d |
    awk -v a="$BRIDGE" -v b="$BACKUP_BRIDGE" 'stop { next } $1 == "-A" && $3 == "-i" && ($4 == a || $4 == b) && $5 == "-j" && NF == 6 { print; next } { stop = 1 }')
  for which in worker backup; do
    use_bridge "$which"
    chain=$(echo "$leading" | sed -n "s/^-A DOCKER-USER -i $B -j \($PREFIX-[AB]\)\$/\1/p" | head -1)
    [ -n "$chain" ] || fail "the first DOCKER-USER rules do not include the jump for $B (run install)"
    iptables -C INPUT -i "$B" -j DROP 2>/dev/null || fail "no INPUT drop for $B"
    iptables -S "$chain" | grep -qE -- '--dport 53 -j RETURN$' ||
      fail "$chain allows no DNS resolver: $WHO cannot resolve names (set MKT_EGRESS_DNS, run install)"
    iptables -C "$chain" -p tcp --dport 443 -j RETURN 2>/dev/null || fail "no 443 rule in $chain"
    [ "$(iptables -S "$chain" | tail -1)" = "-A $chain -j DROP" ] || fail "$chain does not end in DROP"
    if docker network inspect "$NETWORK" >/dev/null 2>&1; then
      [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NETWORK")" = "$B" ] ||
        fail "$NETWORK is not on bridge $B (the bridge name differs between compose and this firewall?)"
      [ "$(docker network inspect -f '{{.EnableIPv6}}' "$NETWORK")" = false ] ||
        fail "$NETWORK has IPv6 enabled; these rules are IPv4 only"
    else
      echo "mkt-egress: $NETWORK does not exist yet (the rules are in place for when it does)"
    fi
    summary="${summary:+$summary, }$B $chain"
  done
  echo "mkt-egress: ok ($summary)"
}

case "${1:-}" in
  install) install ;;
  check) check ;;
  *)
    echo "usage: mkt-egress.sh install|check" >&2
    exit 64
    ;;
esac
