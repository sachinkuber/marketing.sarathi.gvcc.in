// The worker egress firewall (infra/prod/firewall, ruling R9; R15 for what it allows): the rules the script
// would install, read from its dry run (MKT_EGRESS_DRY_RUN=1 prints each iptables command and runs none), and
// the systemd unit that installs them before Docker starts. Needs bash only; it never touches a firewall.
//   node --test infra/prod/test/firewall.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(root, 'infra/prod/firewall/mkt-egress.sh')
let dir

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'mkt-firewall-'))
})
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function dryRun(args, env = {}, extra = {}) {
  const daemon = join(dir, 'daemon.json')
  writeFileSync(daemon, env.daemonJson ?? '{"log-driver":"json-file"}')
  const resolv = join(dir, 'resolv.conf')
  writeFileSync(
    resolv,
    env.resolv ?? 'nameserver 127.0.0.53\nnameserver 192.0.2.10\nnameserver 198.51.100.53\n',
  )
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: process.env.PATH,
      MKT_EGRESS_DRY_RUN: '1',
      MKT_DOCKER_DAEMON_JSON: daemon,
      MKT_EGRESS_RESOLV_CONF: resolv,
      MKT_EGRESS_DNS_WAIT: '0',
      ...extra,
    },
  })
}

const rules = (out) => out.split('\n').filter((l) => l.startsWith('iptables '))

test('the chain allows replies, then DNS to the resolvers, then drops private ranges and the host, then 443', () => {
  const out = dryRun(['install'])
  assert.equal(out.status, 0, out.stderr)
  const egress = rules(out.stdout).filter((l) => / -A MKT-EGRESS-A /.test(l))
  const index = (pattern) => egress.findIndex((l) => pattern.test(l))
  assert.match(egress[0], /--ctstate ESTABLISHED,RELATED -j RETURN$/)
  // The resolvers, loopback excluded, before any DROP (cloud resolvers sit in 10/8 and 169.254/16).
  for (const resolver of ['192.0.2.10', '198.51.100.53']) {
    for (const proto of ['udp', 'tcp']) {
      assert.ok(
        index(new RegExp(`-d ${resolver.replace(/\./g, '\\.')}/32 -p ${proto} --dport 53 -j RETURN`)) > 0,
      )
    }
  }
  assert.ok(!egress.some((l) => /127\.0\.0\.53/.test(l)))
  const firstDrop = index(/-j DROP$/)
  const lastDns = Math.max(...egress.map((l, i) => (/--dport 53/.test(l) ? i : -1)))
  assert.ok(lastDns < firstDrop, 'a DNS rule comes after a DROP')
  for (const net of [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '169.254.0.0/16',
    '127.0.0.0/8',
  ]) {
    assert.ok(index(new RegExp(`-d ${net.replace(/\./g, '\\.')} -j DROP$`)) > lastDns, net)
  }
  const local = index(/-m addrtype --dst-type LOCAL -j DROP$/)
  const https = index(/-p tcp --dport 443 -j RETURN$/)
  assert.ok(local > lastDns && https > local)
  assert.match(egress.at(-1), /-A MKT-EGRESS-A -j DROP$/)
  assert.equal(egress.filter((l) => /-j RETURN$/.test(l) && !/--dport (53|443)|ctstate/.test(l)).length, 0)
})

test('the bridge is hooked first in DOCKER-USER, and dropped in INPUT (the host itself)', () => {
  const all = rules(dryRun(['install']).stdout)
  assert.ok(all.includes('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A'), all.join('\n'))
  assert.ok(all.includes('iptables -I INPUT 1 -i mkt-egress0 -j DROP'))
})

test('MKT_EGRESS_DNS replaces the resolvers read from resolv.conf', () => {
  const out = dryRun(['install'])
  const custom = spawnSync('bash', [script, 'install'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MKT_EGRESS_DRY_RUN: '1',
      MKT_EGRESS_DNS: '192.0.2.53',
      MKT_DOCKER_DAEMON_JSON: '/nonexistent',
    },
  })
  assert.equal(custom.status, 0, custom.stderr)
  assert.match(custom.stdout, /-d 192\.0\.2\.53\/32 -p udp --dport 53 -j RETURN/)
  assert.doesNotMatch(custom.stdout, /192\.0\.2\.10\/32/)
  assert.match(out.stdout, /192\.0\.2\.10\/32/)
})

test('Docker on its nftables backend is refused loudly (DOCKER-USER would not apply)', () => {
  const out = dryRun(['install'], { daemonJson: '{"firewall-backend": "nftables"}' })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /nftables/)
  assert.equal(rules(out.stdout).length, 0)
})

test('an unknown command is a usage error', () => {
  assert.equal(dryRun(['bogus']).status, 64)
})

test('the systemd unit runs the install before Docker starts', () => {
  const unit = readFileSync(join(root, 'infra/prod/firewall/mkt-egress.service'), 'utf8')
  assert.match(unit, /^Before=docker\.service$/m)
  assert.match(unit, /^Type=oneshot$/m)
  assert.match(unit, /^RemainAfterExit=yes$/m)
  assert.match(unit, /^ExecStart=\/opt\/mkt\/firewall\/mkt-egress\.sh install$/m)
  assert.match(unit, /^WantedBy=.*docker\.service/m)
})

test('no resolver found (only the 127.0.0.53 stub): install still hooks a chain with no DNS rule, and fails', () => {
  const out = dryRun(['install'], { resolv: 'nameserver 127.0.0.53\n' })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /no DNS resolver/)
  assert.match(out.stderr, /MKT_EGRESS_DNS/)
  const all = rules(out.stdout)
  assert.ok(!all.some((l) => /--dport 53/.test(l)), all.join('\n'))
  assert.ok(all.includes('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A'))
  assert.ok(all.includes('iptables -A MKT-EGRESS-A -d 10.0.0.0/8 -j DROP'))
  assert.equal(all.filter((l) => / -A MKT-EGRESS-A /.test(l)).at(-1), 'iptables -A MKT-EGRESS-A -j DROP')
  // An empty MKT_EGRESS_DNS names no resolver either.
  const empty = dryRun(['install'], {}, { MKT_EGRESS_DNS: '' })
  assert.notEqual(empty.status, 0)
  assert.ok(!rules(empty.stdout).some((l) => /--dport 53/.test(l)))
})

test('MKT_EGRESS_BRIDGE names another bridge', () => {
  const out = dryRun(['install'], {}, { MKT_EGRESS_BRIDGE: 'mkt-m7t-egress0' })
  assert.equal(out.status, 0, out.stderr)
  assert.ok(rules(out.stdout).includes('iptables -I DOCKER-USER 1 -i mkt-m7t-egress0 -j MKT-EGRESS-A'))
  assert.ok(!out.stdout.includes('-i mkt-egress0 '))
})

// A stand-in iptables (and docker) on PATH: it logs every call, answers -L / -S / -C from a small state, and
// changes nothing. Used for the parts the dry run cannot show: the swap on a re-run, and `check`.
function stubbed(args, { dockerUser = [], chains = {}, extra = {}, fresh = false } = {}) {
  const bin = mkdtempSync(join(dir, 'bin-'))
  const state = mkdtempSync(join(dir, 'state-'))
  // fresh: Docker has never run, so there is no DOCKER-USER chain yet (the first boot).
  if (!fresh) writeFileSync(join(state, 'DOCKER-USER'), ['-N DOCKER-USER', ...dockerUser].join('\n') + '\n')
  writeFileSync(join(state, 'INPUT'), '-P INPUT ACCEPT\n-A INPUT -i mkt-egress0 -j DROP\n')
  for (const [name, lines] of Object.entries(chains)) {
    writeFileSync(join(state, name), [`-N ${name}`, ...lines].join('\n') + '\n')
  }
  writeFileSync(
    join(bin, 'iptables'),
    `#!/bin/bash
echo "iptables $*" >> "${join(state, 'log')}"
if [ -n "$STUB_FAIL_ON" ] && [[ "$*" == *"$STUB_FAIL_ON"* ]]; then exit 1; fi
S="${state}"
case "$1" in
  -n) [ -f "$S/$3" ]; exit ;;
  -S) cat "$S/$2" 2>/dev/null; exit ;;
  -C) chain=$2; shift 2; grep -qxF -- "-A $chain $*" "$S/$chain" 2>/dev/null; exit ;;
esac
exit 0
`,
    { mode: 0o755 },
  )
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
  const out = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      MKT_DOCKER_DAEMON_JSON: '/nonexistent',
      MKT_EGRESS_DNS: '192.0.2.53',
      MKT_EGRESS_DNS_WAIT: '0',
      ...extra,
    },
  })
  // No log file: the script made no iptables call at all.
  const logFile = join(state, 'log')
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []
  return { ...out, log }
}

test('a re-run builds the other chain first, then swaps the jump, then removes the old chain', () => {
  const out = stubbed(['install'], {
    dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-A'],
    chains: { 'MKT-EGRESS-A': ['-A MKT-EGRESS-A -j DROP'] },
  })
  assert.equal(out.status, 0, out.stderr)
  const at = (line) => out.log.indexOf(line)
  const built = at('iptables -N MKT-EGRESS-B')
  const filled = out.log.findLastIndex((l) => l.startsWith('iptables -A MKT-EGRESS-B '))
  const jumped = at('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-B')
  const unhooked = at('iptables -D DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-A')
  const removed = at('iptables -X MKT-EGRESS-A')
  assert.ok(built >= 0 && filled > built && jumped > filled, out.log.join('\n'))
  assert.ok(unhooked > jumped && removed > unhooked, out.log.join('\n'))
  // The old chain is never flushed while a jump still points at it.
  assert.ok(at('iptables -F MKT-EGRESS-A') > unhooked)
  // The INPUT drop already exists: it is not removed and added again.
  assert.equal(at('iptables -D INPUT -i mkt-egress0 -j DROP'), -1)
})

test('the first install on a fresh host (no DOCKER-USER chain yet) creates it and installs the rules', () => {
  const out = stubbed(['install'], { fresh: true })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /installed MKT-EGRESS-A/)
  const at = (line) => out.log.indexOf(line)
  assert.ok(at('iptables -N DOCKER-USER') >= 0, out.log.join('\n'))
  assert.ok(at('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A') > at('iptables -N MKT-EGRESS-A'))
})

// Calls that change something (everything but -S, -L, -C).
const changes = (log) => log.filter((l) => !/^iptables (-S|-n -L|-C) /.test(l))

test('fresh host, no resolver: fails closed (a hooked chain that drops DNS and private ranges) and exits 1', () => {
  const out = stubbed(['install'], { fresh: true, extra: { MKT_EGRESS_DNS: '' } })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /no DNS resolver/)
  const log = out.log
  assert.ok(!log.some((l) => /--dport 53/.test(l)), log.join('\n'))
  assert.ok(log.includes('iptables -A MKT-EGRESS-A -d 10.0.0.0/8 -j DROP'))
  assert.ok(log.includes('iptables -A MKT-EGRESS-A -j DROP'))
  assert.ok(
    log.indexOf('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A') >
      log.indexOf('iptables -A MKT-EGRESS-A -j DROP'),
  )
})

test('existing good chain, no resolver: the chain is left exactly as it is, and install exits 1', () => {
  const out = stubbed(['install'], {
    dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-B'],
    chains: { 'MKT-EGRESS-B': GOOD_CHAIN },
    extra: { MKT_EGRESS_DNS: '' },
  })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /left in place/)
  assert.deepEqual(changes(out.log), [])
})

test('a failure while building on a fresh host leaves the bridge dropped, not open', () => {
  const out = stubbed(['install'], { fresh: true, extra: { STUB_FAIL_ON: '--dport 443' } })
  assert.notEqual(out.status, 0)
  assert.ok(out.log.includes('iptables -I DOCKER-USER 1 -i mkt-egress0 -j DROP'), out.log.join('\n'))
  assert.ok(!out.log.includes('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A'))
  assert.match(out.stderr, /dropped/)
})

test('a failure while building beside a good chain leaves the good chain hooked and adds nothing to DOCKER-USER', () => {
  const out = stubbed(['install'], {
    dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-B'],
    chains: { 'MKT-EGRESS-B': GOOD_CHAIN },
    extra: { STUB_FAIL_ON: '--dport 443' },
  })
  assert.notEqual(out.status, 0)
  assert.ok(!out.log.some((l) => /^iptables (-I|-D) DOCKER-USER/.test(l)), out.log.join('\n'))
  assert.ok(!out.log.includes('iptables -X MKT-EGRESS-B'))
})

test('a successful install removes an emergency DROP left by a failed one', () => {
  const out = stubbed(['install'], { dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j DROP'] })
  assert.equal(out.status, 0, out.stderr)
  const log = out.log
  assert.ok(
    log.indexOf('iptables -D DOCKER-USER -i mkt-egress0 -j DROP') >
      log.indexOf('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS-A'),
  )
})

const GOOD_CHAIN = [
  '-A MKT-EGRESS-B -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN',
  '-A MKT-EGRESS-B -d 192.0.2.53/32 -p udp -m udp --dport 53 -j RETURN',
  '-A MKT-EGRESS-B -d 10.0.0.0/8 -j DROP',
  '-A MKT-EGRESS-B -p tcp --dport 443 -j RETURN',
  '-A MKT-EGRESS-B -j DROP',
]

test('check passes on the installed rules', () => {
  const out = stubbed(['check'], {
    dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-B'],
    chains: { 'MKT-EGRESS-B': GOOD_CHAIN },
  })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /mkt-egress: ok/)
})

test('check fails when the chain allows no DNS resolver', () => {
  const out = stubbed(['check'], {
    dockerUser: ['-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-B'],
    chains: { 'MKT-EGRESS-B': GOOD_CHAIN.filter((l) => !/--dport 53/.test(l)) },
  })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /no DNS/)
})

test('check fails when the jump is not the first DOCKER-USER rule', () => {
  const out = stubbed(['check'], {
    dockerUser: ['-A DOCKER-USER -j RETURN', '-A DOCKER-USER -i mkt-egress0 -j MKT-EGRESS-B'],
    chains: { 'MKT-EGRESS-B': GOOD_CHAIN },
  })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /first DOCKER-USER rule/)
})

test('the unit reads the bridge name and resolvers from one env file, after resolved and the network', () => {
  const unit = readFileSync(join(root, 'infra/prod/firewall/mkt-egress.service'), 'utf8')
  assert.match(unit, /^EnvironmentFile=-\/opt\/mkt\/compose\.env$/m)
  assert.match(unit, /^After=.*systemd-resolved\.service/m)
  assert.match(unit, /^After=.*network-online\.target/m)
  assert.match(unit, /^Wants=network-online\.target$/m)
})
