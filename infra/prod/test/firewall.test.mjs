// The worker egress firewall (infra/prod/firewall, ruling R9; R15 for what it allows): the rules the script
// would install, read from its dry run (MKT_EGRESS_DRY_RUN=1 prints each iptables command and runs none), and
// the systemd unit that installs them before Docker starts. Needs bash only; it never touches a firewall.
//   node --test infra/prod/test/firewall.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function dryRun(args, env = {}) {
  const daemon = join(dir, 'daemon.json')
  writeFileSync(daemon, env.daemonJson ?? '{"log-driver":"json-file"}')
  const resolv = join(dir, 'resolv.conf')
  writeFileSync(
    resolv,
    env.resolv ?? 'nameserver 127.0.0.53\nnameserver 192.0.2.10\nnameserver 198.51.100.53\n',
  )
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      MKT_EGRESS_DRY_RUN: '1',
      MKT_DOCKER_DAEMON_JSON: daemon,
      MKT_EGRESS_RESOLV_CONF: resolv,
    },
  })
}

const rules = (out) => out.split('\n').filter((l) => l.startsWith('iptables '))

test('the chain allows replies, then DNS to the resolvers, then drops private ranges and the host, then 443', () => {
  const out = dryRun(['install'])
  assert.equal(out.status, 0, out.stderr)
  const egress = rules(out.stdout).filter((l) => / -A MKT-EGRESS /.test(l))
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
  assert.match(egress.at(-1), /-A MKT-EGRESS -j DROP$/)
  assert.equal(egress.filter((l) => /-j RETURN$/.test(l) && !/--dport (53|443)|ctstate/.test(l)).length, 0)
})

test('the bridge is hooked first in DOCKER-USER, and dropped in INPUT (the host itself)', () => {
  const all = rules(dryRun(['install']).stdout)
  assert.ok(all.includes('iptables -I DOCKER-USER 1 -i mkt-egress0 -j MKT-EGRESS'), all.join('\n'))
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
