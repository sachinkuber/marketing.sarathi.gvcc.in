#!/bin/bash
# The worker's egress firewall (plan M7, ruling R9). The worker's only way out is the compose network
# worker_egress, whose bridge is always named mkt-egress0 (infra/prod/compose.yaml). From that bridge it allows
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
# Environment: MKT_EGRESS_DNS="a.b.c.d ..." names the resolvers instead of reading MKT_EGRESS_RESOLV_CONF
# (default /run/systemd/resolve/resolv.conf, else /etc/resolv.conf). MKT_EGRESS_DRY_RUN=1 prints each iptables
# command instead of running it (used by infra/prod/test/firewall.test.mjs).
set -euo pipefail

BRIDGE=mkt-egress0
NETWORK=mkt_worker_egress
CHAIN=MKT-EGRESS
DAEMON_JSON=${MKT_DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}
BLOCKED="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4"

fail() {
  echo "mkt-egress: $*" >&2
  exit 1
}

ipt() {
  if [ -n "${MKT_EGRESS_DRY_RUN:-}" ]; then echo "iptables $*"; else iptables "$@"; fi
}

# Docker's own nftables backend has no DOCKER-USER chain: rules here would silently not apply.
check_backend() {
  if grep -qsE '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' "$DAEMON_JSON"; then
    fail "Docker is set to its nftables firewall backend ($DAEMON_JSON): DOCKER-USER does not exist and these rules would not apply. Stop and ask."
  fi
}

resolvers() {
  if [ -n "${MKT_EGRESS_DNS+x}" ]; then
    echo "$MKT_EGRESS_DNS"
    return
  fi
  local file=${MKT_EGRESS_RESOLV_CONF:-/run/systemd/resolve/resolv.conf}
  [ -r "$file" ] || file=/etc/resolv.conf
  # IPv4 resolvers only, loopback excluded (a container cannot use the host's stub resolver).
  awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 !~ /^127\./ { print $2 }' "$file"
}

install() {
  check_backend
  if [ -z "${MKT_EGRESS_DRY_RUN:-}" ]; then
    iptables -n -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
    if iptables -n -L "$CHAIN" >/dev/null 2>&1; then iptables -F "$CHAIN"; else iptables -N "$CHAIN"; fi
  fi
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  # DNS first: cloud resolvers often sit in 10/8 or 169.254/16, which are dropped just below.
  for resolver in $(resolvers); do
    ipt -A "$CHAIN" -d "$resolver/32" -p udp --dport 53 -j RETURN
    ipt -A "$CHAIN" -d "$resolver/32" -p tcp --dport 53 -j RETURN
  done
  for net in $BLOCKED; do
    ipt -A "$CHAIN" -d "$net" -j DROP
  done
  # The host's own addresses (its published ports are translated to container addresses, dropped above).
  ipt -A "$CHAIN" -m addrtype --dst-type LOCAL -j DROP
  ipt -A "$CHAIN" -p tcp --dport 443 -j RETURN
  ipt -A "$CHAIN" -j DROP
  if [ -z "${MKT_EGRESS_DRY_RUN:-}" ]; then
    while iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null; do
      iptables -D DOCKER-USER -i "$BRIDGE" -j "$CHAIN"
    done
    while iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null; do iptables -D INPUT -i "$BRIDGE" -j DROP; done
  fi
  ipt -I DOCKER-USER 1 -i "$BRIDGE" -j "$CHAIN"
  # Anything from the bridge to the host's own services.
  ipt -I INPUT 1 -i "$BRIDGE" -j DROP
  echo "mkt-egress: installed for $BRIDGE (DNS: $(resolvers | tr '\n' ' '))"
}

check() {
  check_backend
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || fail "no DOCKER-USER chain"
  [ "$(iptables -S DOCKER-USER | sed -n 2p)" = "-A DOCKER-USER -i $BRIDGE -j $CHAIN" ] ||
    fail "the first DOCKER-USER rule is not the jump for $BRIDGE (run install)"
  iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || fail "no INPUT drop for $BRIDGE"
  iptables -C "$CHAIN" -p tcp --dport 443 -j RETURN 2>/dev/null || fail "no 443 rule in $CHAIN"
  [ "$(iptables -S "$CHAIN" | tail -1)" = "-A $CHAIN -j DROP" ] || fail "$CHAIN does not end in DROP"
  local backend
  backend=$(docker info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null || true)
  case "$backend" in *nftables*) fail "Docker reports its nftables firewall backend" ;; esac
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NETWORK")" = "$BRIDGE" ] ||
      fail "$NETWORK is not on bridge $BRIDGE (recreate it from infra/prod/compose.yaml)"
    [ "$(docker network inspect -f '{{.EnableIPv6}}' "$NETWORK")" = false ] ||
      fail "$NETWORK has IPv6 enabled; these rules are IPv4 only"
  else
    echo "mkt-egress: $NETWORK does not exist yet (the rules are in place for when it does)"
  fi
  echo "mkt-egress: ok"
}

case "${1:-}" in
  install) install ;;
  check) check ;;
  *)
    echo "usage: mkt-egress.sh install|check" >&2
    exit 64
    ;;
esac
