import { withBrand } from '@mkt/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptFound, addSuggestions, decideSuggestion } from '../src/onboarding/suggestions.ts'
import { qualifiesAsFactSource, type SourceKind } from '../src/onboarding/sources.ts'
import { storedExtract } from '../src/onboarding/research-results.ts'
import { addBrand, addUser, createStack, enrolledClient, type Stack, type TestClient } from './support.ts'

const PASSWORD = 'correct horse battery'

let stack: Stack
let brandId: string
let ownerId: string
let owner: TestClient
let admin: TestClient
let seq = 0

const deps = () => ({ audit: stack.audit })
const actor = () => ({ userId: ownerId })
const base = () => `/api/v1/brands/${brandId}/onboarding/suggestions`

async function source(kind: string, extract = 'text', address: string | null = null): Promise<string> {
  const made = await stack.db.admin.query(
    `insert into app.research_source (brand_id, kind, address, result, extract) values ($1, $2, $3, 'read', $4) returning id`,
    [brandId, kind, address, extract],
  )
  return made.rows[0].id as string
}

async function add(
  items: Partial<Parameters<typeof addSuggestions>[2]['items'][number]>[],
): Promise<string[]> {
  return withBrand(stack.appPool, brandId, (client) =>
    addSuggestions(client, deps(), {
      brandId,
      runId: null,
      items: items.map((i) => ({
        step: 'profile' as const,
        key: `k${(seq += 1)}`,
        proposed: 'warm',
        why: 'seen on the site',
        sourceIds: [],
        confidence: 'found' as const,
        ...i,
      })),
    }),
  )
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await stack.db.admin.query(sql, [brandId, ...params])).rows

beforeAll(async () => {
  stack = await createStack()
  brandId = await addBrand(stack, 'onboarding-a')
  // The brand's own site is aztek.example (ruling R41: a site source counts for a fact only there).
  await stack.db.admin.query(`insert into app.onboarding (brand_id, intake) values ($1, $2::jsonb)`, [
    brandId,
    JSON.stringify({ website: 'https://www.aztek.example/', socials: {}, competitors: [] }),
  ])
  ownerId = await addUser(stack, { email: 'owner@example.test', password: PASSWORD, platformOwner: true })
  await addUser(stack, { email: 'admin@example.test', password: PASSWORD, role: 'brand_admin', brandId })
  owner = (await enrolledClient(stack, 'owner@example.test', PASSWORD)).client
  admin = (await enrolledClient(stack, 'admin@example.test', PASSWORD)).client
})
afterAll(async () => stack?.close())

describe('qualifiesAsFactSource', () => {
  const web = 'https://aztek.example/'
  const at = (kind: SourceKind, address: string | null = null) => ({ kind, address })
  it('is true only when the brand site, a document or an owner statement is among the sources', () => {
    expect(
      qualifiesAsFactSource(
        [at('social', web), at('search', web), at('competitor', 'https://rival.example/')],
        web,
      ),
    ).toBe(false)
    expect(qualifiesAsFactSource([], web)).toBe(false)
    expect(
      qualifiesAsFactSource([at('search', 'https://news.example/'), at('site', `${web}about`)], web),
    ).toBe(true)
    expect(qualifiesAsFactSource([at('document', 'brochure.pdf, pages 1-4')], web)).toBe(true)
    expect(qualifiesAsFactSource([at('owner_statement')], web)).toBe(true)
    expect(qualifiesAsFactSource([at('document')], null)).toBe(true)
    expect(qualifiesAsFactSource([at('owner_statement')], null)).toBe(true)
  })

  it('counts a page labelled site only on the brand own registrable domain (ruling R41)', () => {
    // The brand's pages, with or without www, and its subdomains.
    for (const address of [
      'https://aztek.example/x',
      'https://www.aztek.example/',
      'https://shop.aztek.example/a',
    ])
      expect(qualifiesAsFactSource([at('site', address)], web), address).toBe(true)
    // A third party's page, whatever the model labelled it, and a lookalike.
    for (const address of [
      'https://rival.example/',
      'https://aztek.example.evil.test/',
      'https://notaztek.example/',
      null,
    ])
      expect(qualifiesAsFactSource([at('site', address)], web), String(address)).toBe(false)
    // With no intake website, no page labelled site can stand behind a fact.
    expect(qualifiesAsFactSource([at('site', 'https://aztek.example/x')], null)).toBe(false)
    expect(qualifiesAsFactSource([at('site', 'https://aztek.example/x')], 'not a web address')).toBe(false)
  })
})

describe('suggest then decide', () => {
  it('accepting a profile suggestion writes one profile item with its sources', async () => {
    const s = await source('site')
    const [id] = await add([{ key: 'tone', proposed: 'warm', sourceIds: [s] }])
    const out = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'accepted',
      actor: actor(),
    })
    const items = await rows('select * from app.profile_item where brand_id = $1 and key = $2', ['tone'])
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(out.createdId)
    expect(items[0].value).toBe('warm')
    expect(items[0].source_ids).toEqual([s])
    expect(items[0].from_suggestion).toBe(id)
    const sug = (await rows('select * from app.suggestion where brand_id = $1 and id = $2', [id]))[0]
    expect(sug.decision).toBe('accepted')
    expect(sug.decided_by).toBe(ownerId)
  })

  it('editing a fact records an owner_statement source with the exact wording and the deciding user', async () => {
    const weak = await source('social')
    const [id] = await add([
      {
        step: 'fact',
        key: 'founded',
        proposed: { statement: 'Founded in 1999', reviewDate: '2099-06-01' },
        sourceIds: [weak],
      },
    ])
    const wording = 'We opened our first shop in 1998.'
    const out = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'edited',
      value: wording,
      reason: 'the site is wrong',
      actor: actor(),
    })
    const fact = (
      await rows('select * from app.verified_fact where brand_id = $1 and id = $2', [out.createdId])
    )[0]
    expect(fact.statement).toBe(wording)
    expect(fact.confirmed_by).toBe(ownerId)
    expect(fact.review_date.toISOString().slice(0, 10)).toBe('2099-06-01')
    expect(fact.source_ids).toHaveLength(2)
    const added = await rows(
      `select kind, extract from app.research_source where brand_id = $1 and id = any($2::uuid[]) and kind = 'owner_statement'`,
      [fact.source_ids],
    )
    expect(added).toEqual([{ kind: 'owner_statement', extract: wording }])
    expect(fact.fact_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a fact whose only sources are social, search or competitor, and writes nothing', async () => {
    const kinds = ['social', 'search', 'competitor']
    const sources = await Promise.all(kinds.map((k) => source(k)))
    const [id] = await add([
      {
        step: 'fact',
        key: 'weak',
        proposed: { statement: 'X', reviewDate: '2099-01-01' },
        sourceIds: sources,
      },
    ])
    const before = (await rows('select count(*)::int as n from app.verified_fact where brand_id = $1'))[0].n
    await expect(
      decideSuggestion(stack.appPool, deps(), {
        brandId,
        suggestionId: id!,
        decision: 'accepted',
        actor: actor(),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'fact_needs_source' })
    expect((await rows('select count(*)::int as n from app.verified_fact where brand_id = $1'))[0].n).toBe(
      before,
    )
    const sug = (await rows('select decision from app.suggestion where brand_id = $1 and id = $2', [id]))[0]
    expect(sug.decision).toBeNull()
    // The same refusal over HTTP.
    const reply = await owner.request('POST', `${base()}/${id}/decision`, { body: { decision: 'accepted' } })
    expect(reply.status).toBe(422)
    expect(reply.json.error.code).toBe('fact_needs_source')
  })

  it('refuses an impossible review date with the 422, not a 500', async () => {
    const s = await source('site')
    const [id] = await add([
      {
        step: 'fact',
        key: 'bad-date',
        proposed: { statement: 'Open daily', reviewDate: '2026-02-30' },
        sourceIds: [s],
      },
    ])
    await expect(
      decideSuggestion(stack.appPool, deps(), {
        brandId,
        suggestionId: id!,
        decision: 'accepted',
        actor: actor(),
      }),
    ).rejects.toMatchObject({ status: 422, code: 'review_date_needed' })
    const reply = await owner.request('POST', `${base()}/${id}/decision`, { body: { decision: 'accepted' } })
    expect(reply.status).toBe(422)
    expect(reply.json.error.code).toBe('review_date_needed')
  })

  it('accepts a fact that has a source on the brand site', async () => {
    const s = await source('site', 'text', 'https://aztek.example/hours')
    const [id] = await add([
      {
        step: 'fact',
        key: 'ok',
        proposed: { statement: 'Open daily', reviewDate: '2099-01-01' },
        sourceIds: [s],
      },
    ])
    const out = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'accepted',
      actor: actor(),
    })
    const fact = (
      await rows('select source_ids from app.verified_fact where brand_id = $1 and id = $2', [out.createdId])
    )[0]
    expect(fact.source_ids).toEqual([s])
  })

  it('writes a safety rule when a rule suggestion is accepted', async () => {
    const [id] = await add([
      {
        step: 'rule',
        key: 'r1',
        proposed: { kind: 'forbidden_word', text: 'cheap' },
        why: 'brand is premium',
      },
    ])
    const out = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'accepted',
      actor: actor(),
    })
    const rule = (
      await rows('select * from app.safety_rule where brand_id = $1 and id = $2', [out.createdId])
    )[0]
    expect(rule).toMatchObject({
      kind: 'forbidden_word',
      text: 'cheap',
      why: 'brand is premium',
      active: true,
    })
  })

  it('records only the decision for a question, and for a rejection', async () => {
    const [q, p] = await add([{ step: 'question', key: 'q1' }, { key: 'rej' }])
    const a = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: q!,
      decision: 'accepted',
      actor: actor(),
    })
    const b = await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: p!,
      decision: 'rejected',
      reason: 'not us',
      actor: actor(),
    })
    expect(a.createdId).toBeNull()
    expect(b.createdId).toBeNull()
    expect(
      (
        await rows('select count(*)::int as n from app.profile_item where key = $2 and brand_id = $1', [
          'rej',
        ])
      )[0].n,
    ).toBe(0)
  })

  it('a second decision on the same suggestion is refused', async () => {
    const [id] = await add([{}])
    await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'rejected',
      actor: actor(),
    })
    await expect(
      decideSuggestion(stack.appPool, deps(), {
        brandId,
        suggestionId: id!,
        decision: 'accepted',
        actor: actor(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'already_decided' })
    const reply = await owner.request('POST', `${base()}/${id}/decision`, { body: { decision: 'accepted' } })
    expect(reply.status).toBe(409)
    expect(reply.json.error.code).toBe('already_decided')
  })

  it('a re-run supersedes only undecided suggestions', async () => {
    const [decided, open] = await add([{ key: 'rerun-a' }, { key: 'rerun-b' }])
    await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: decided!,
      decision: 'accepted',
      actor: actor(),
    })
    const [newA, newB] = await add([{ key: 'rerun-a' }, { key: 'rerun-b' }])
    const state = async (id: string) =>
      (
        await rows('select decision, superseded_by from app.suggestion where brand_id = $1 and id = $2', [id])
      )[0]
    expect(await state(decided!)).toEqual({ decision: 'accepted', superseded_by: null })
    expect(await state(open!)).toEqual({ decision: null, superseded_by: newB })
    expect(await state(newA!)).toEqual({ decision: null, superseded_by: null })
    await expect(
      decideSuggestion(stack.appPool, deps(), {
        brandId,
        suggestionId: open!,
        decision: 'accepted',
        actor: actor(),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'superseded' })
  })

  it('accept-found accepts found items only', async () => {
    const step = 'choice' as const
    const [f, a, u] = await add([
      { step, key: 'af-1', confidence: 'found' },
      { step, key: 'af-2', confidence: 'assumed' },
      { step, key: 'af-3', confidence: 'unknown' },
    ])
    const out = await acceptFound(stack.appPool, deps(), { brandId, step, actor: actor() })
    expect(out).toEqual({ accepted: 1 })
    const decisions = await rows(
      'select id, decision from app.suggestion where brand_id = $1 and id = any($2::uuid[])',
      [[f, a, u]],
    )
    const by = Object.fromEntries(decisions.map((r) => [r.id, r.decision]))
    expect(by[f!]).toBe('accepted')
    expect(by[a!]).toBeNull()
    expect(by[u!]).toBeNull()
    // Over HTTP only the draft profile has a bulk accept (M6); every other step is decided one at a time.
    for (const other of ['choice', 'question', 'fact', 'rule']) {
      const refused = await owner.request('POST', `${base()}/accept-found`, { body: { step: other } })
      expect(refused.status, other).toBe(400)
      expect(refused.json.error).toMatchObject({
        code: 'one_at_a_time',
        message: expect.stringContaining('Facts and rules are confirmed one at a time'),
      })
    }
    const [p] = await add([{ key: 'af-profile', confidence: 'found' }])
    const reply = await owner.request('POST', `${base()}/accept-found`, { body: { step: 'profile' } })
    expect(reply.status).toBe(200)
    expect(reply.json.accepted).toBeGreaterThanOrEqual(1)
    expect(
      (await rows('select decision from app.suggestion where brand_id = $1 and id = $2', [p]))[0].decision,
    ).toBe('accepted')
  })

  it('an empty or 4001-character edited value is refused naming value', async () => {
    const [id] = await add([{}])
    for (const value of ['', '   ', 'x'.repeat(4001)]) {
      const reply = await owner.request('POST', `${base()}/${id}/decision`, {
        body: { decision: 'edited', value },
      })
      expect(reply.status, JSON.stringify(value).slice(0, 10)).toBe(400)
      expect(reply.json.error.details.map((d: { path: string }) => d.path)).toContain('value')
    }
    const edit = await owner.request('POST', `${base()}/${id}/decision`, { body: { decision: 'edited' } })
    expect(edit.status).toBe(400)
    const ok = await owner.request('POST', `${base()}/${id}/decision`, {
      body: { decision: 'edited', value: 'x'.repeat(3990) },
    })
    expect(ok.status).toBe(200)
  })

  it('a brand admin gets 403; the platform owner gets 200 on the three routes', async () => {
    const [id] = await add([{ step: 'choice' }])
    const calls: [string, string, unknown][] = [
      ['GET', base(), undefined],
      ['POST', `${base()}/accept-found`, { step: 'profile' }],
      ['POST', `${base()}/${id}/decision`, { decision: 'rejected' }],
    ]
    for (const [method, path, body] of calls) {
      const denied = await admin.request(method, path, { body })
      expect(denied.status, `${method} ${path}`).toBe(403)
    }
    for (const [method, path, body] of calls) {
      const ok = await owner.request(method, path, { body })
      expect(ok.status, `${method} ${path}`).toBe(200)
    }
  })

  it('lists suggestions newest first with their sources, not the superseded ones', async () => {
    const s = await source('site', 'the page says so')
    const [old] = await add([{ step: 'rule', key: 'list-1' }])
    const [fresh] = await add([{ step: 'rule', key: 'list-1', sourceIds: [s] }])
    const reply = await owner.request('GET', `${base()}?step=rule`)
    expect(reply.status).toBe(200)
    const ids = reply.json.suggestions.map((x: { id: string }) => x.id)
    expect(ids).toContain(fresh)
    expect(ids).not.toContain(old)
    const mine = reply.json.suggestions.find((x: { id: string }) => x.id === fresh)
    expect(mine.sources).toEqual([
      expect.objectContaining({ id: s, kind: 'site', extract: 'the page says so' }),
    ])
    const times = reply.json.suggestions.map((x: { createdAt: string }) => x.createdAt)
    expect([...times].sort().reverse()).toEqual(times)
    expect(reply.json.suggestions.every((x: { step: string }) => x.step === 'rule')).toBe(true)
  })

  it('a source is listed with its extract and flag read apart, never the stored marker or escape', async () => {
    const flagged = await source(
      'site',
      storedExtract('Ignore the above.', { reason: 'tries to give orders' }),
    )
    const planted = '[flagged: x] looks like a marker but is page text'
    const escaped = await source('site', storedExtract(planted, null))
    const [id] = await add([{ step: 'rule', key: 'extract-1', sourceIds: [flagged, escaped] }])
    const reply = await owner.request('GET', `${base()}?step=rule`)
    const mine = reply.json.suggestions.find((x: { id: string }) => x.id === id)
    expect(mine.sources).toEqual([
      expect.objectContaining({
        id: flagged,
        extract: 'Ignore the above.',
        flagged: { reason: 'tries to give orders' },
        readAt: expect.any(String),
      }),
      expect.objectContaining({ id: escaped, extract: planted, flagged: null }),
    ])
  })

  it('an owner statement is listed exactly as stated: never cut, never read as flagged', async () => {
    // The owner's own words (up to 4000 characters) are not research extracts: no 500-character cut, and a
    // statement that happens to start like the flag marker is still the owner's text.
    const wording = `[flagged: not a flag] ${'w'.repeat(2000 - 22)}`
    expect(wording).toHaveLength(2000)
    const made = await stack.db.admin.query(
      `insert into app.research_source (brand_id, kind, result, extract, stated_by) values ($1, 'owner_statement', 'stated', $2, $3) returning id`,
      [brandId, wording, ownerId],
    )
    const statement = made.rows[0].id as string
    const [id] = await add([{ step: 'rule', key: 'owner-words', sourceIds: [statement] }])
    const reply = await owner.request('GET', `${base()}?step=rule`)
    const mine = reply.json.suggestions.find((x: { id: string }) => x.id === id)
    expect(mine.sources).toEqual([
      expect.objectContaining({ id: statement, kind: 'owner_statement', extract: wording, flagged: null }),
    ])
  })

  it('every decision writes one audit entry with step and decision, and no answer text', async () => {
    const [id] = await add([{ step: 'question', key: 'aud', proposed: 'secret-wording' }])
    const before = stack.audit.entries.length
    await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: id!,
      decision: 'edited',
      value: 'secret-answer',
      actor: actor(),
    })
    const made = stack.audit.entries.slice(before)
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({
      action: 'onboarding.suggestion_decided',
      actor: ownerId,
      brandId,
      detail: { suggestionId: id, step: 'question', decision: 'edited' },
    })
    expect(JSON.stringify(made[0])).not.toContain('secret')
    const adds = stack.audit.entries.filter((e) => e.action === 'onboarding.suggestions_added')
    expect(adds.length).toBeGreaterThan(0)
    expect(adds.at(-1)?.detail).toMatchObject({ count: expect.any(Number) })
  })

  it('accept-found skips a row another transaction holds, and does not wait or fail', async () => {
    const step = 'choice' as const
    const [a, b] = await add([
      { step, key: 'lock-1' },
      { step, key: 'lock-2' },
    ])
    const holder = await stack.db.admin.connect()
    try {
      await holder.query('begin')
      await holder.query('select id from app.suggestion where id = $1 for update', [a])
      const out = await acceptFound(stack.appPool, deps(), { brandId, step, actor: actor() })
      expect(out.accepted).toBeGreaterThanOrEqual(1)
      const state = Object.fromEntries(
        (
          await rows('select id, decision from app.suggestion where brand_id = $1 and id = any($2::uuid[])', [
            [a, b],
          ])
        ).map((r) => [r.id, r.decision]),
      )
      expect(state[b!]).toBe('accepted')
      expect(state[a!]).toBeNull()
    } finally {
      await holder.query('rollback')
      holder.release()
    }
  })

  it('refuses sources from another brand or unknown, and writes nothing', async () => {
    const other = await addBrand(stack, `onboarding-other-${(seq += 1)}`)
    const foreign = (
      await stack.db.admin.query(
        `insert into app.research_source (brand_id, kind, result, extract) values ($1, 'site', 'read', 'x') returning id`,
        [other],
      )
    ).rows[0].id as string
    const own = await source('site')
    const before = (await rows('select count(*)::int as n from app.suggestion where brand_id = $1'))[0].n
    await expect(
      add([
        { key: 'ok-one', sourceIds: [own] },
        { key: 'bad-one', sourceIds: [foreign] },
      ]),
    ).rejects.toMatchObject({
      status: 422,
      code: 'unknown_source',
      message: expect.stringContaining('1 source id'),
    })
    expect((await rows('select count(*)::int as n from app.suggestion where brand_id = $1'))[0].n).toBe(
      before,
    )
  })

  it('refuses value unless the decision is edited, naming value', async () => {
    const [id] = await add([{}])
    for (const decision of ['accepted', 'rejected']) {
      const reply = await owner.request('POST', `${base()}/${id}/decision`, {
        body: { decision, value: 'x' },
      })
      expect(reply.status).toBe(400)
      const hit = reply.json.error.details.find((d: { path: string }) => d.path === 'value')
      expect(hit.message).toContain('"edited"')
    }
    await expect(
      decideSuggestion(stack.appPool, deps(), {
        brandId,
        suggestionId: id!,
        decision: 'accepted',
        value: 'x',
        actor: actor(),
      }),
    ).rejects.toMatchObject({ status: 400 })
    expect(
      (await rows('select decision from app.suggestion where brand_id = $1 and id = $2', [id]))[0].decision,
    ).toBeNull()
  })

  it('stores a blank reason as null', async () => {
    const [a, b] = await add([{}, {}])
    await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: a!,
      decision: 'rejected',
      reason: '',
      actor: actor(),
    })
    await decideSuggestion(stack.appPool, deps(), {
      brandId,
      suggestionId: b!,
      decision: 'rejected',
      reason: '  ',
      actor: actor(),
    })
    const r = await rows(
      'select decided_reason from app.suggestion where brand_id = $1 and id = any($2::uuid[])',
      [[a, b]],
    )
    expect(r.map((x) => x.decided_reason)).toEqual([null, null])
  })
})
