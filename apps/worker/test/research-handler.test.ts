import { describe, expect, it } from 'vitest'
import { researchGroupResultSchema, type ResearchGroupResult } from '@mkt/shared'
import { ModelStopped, type ModelRequest } from '../src/model.ts'
import type { JobContext, ModelStepResult } from '../src/runner.ts'
import {
  BATCH_MAX_BASE64,
  joinDocumentResults,
  researchGroupHandler,
  requireCaps,
  researchMergeHandler,
  ResearchReplyInvalid,
} from '../src/agents/research.ts'
import { NO_DOCUMENTS } from './no-documents.ts'

const DOC = '11111111-1111-4111-8111-111111111111'
const DOC2 = '22222222-2222-4222-8222-222222222222'
const intake = { website: 'https://shop.example/', socials: {}, competitors: [] }

function source(ref: string, over: Record<string, unknown> = {}) {
  return {
    ref,
    kind: 'site',
    address: `https://shop.example/${ref}`,
    documentId: null,
    result: 'read',
    extract: `text ${ref}`,
    flagged: null,
    ...over,
  }
}
function finding(key: string, proposed: string, refs: string[], over: Record<string, unknown> = {}) {
  return { key, proposed, why: 'Stated.', sourceRefs: refs, confidence: 'found', conflict: false, ...over }
}
const groupResult = (group: string, over: Record<string, unknown> = {}) => ({
  group,
  sources: [source('s1')],
  findings: [finding('business_name', 'Shop', ['s1'])],
  unsettled: [],
  ...over,
})

type Script = (step: string, request: ModelRequest) => ModelStepResult
function stub(input: unknown, script: Script, docs: Partial<JobContext> = {}) {
  const seen: { step: string; request: ModelRequest }[] = []
  const ctx: JobContext = {
    jobId: 'j',
    jobClass: 'production',
    input,
    deadline: new Date(Date.now() + 3_600_000),
    async modelStep(step, request) {
      seen.push({ step, request })
      return script(step, request)
    },
    async checkStop() {},
    ...NO_DOCUMENTS,
    ...docs,
  }
  return { ctx, seen }
}
const ends = (text: string): ModelStepResult => ({
  text,
  stopReason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    serverToolSearches: 0,
    serverToolFetches: 0,
  },
})

describe('the research group handler', () => {
  it('the site group sends both web tools and returns a valid group result', async () => {
    const { ctx, seen } = stub({ group: 'site', intake }, () => ends(JSON.stringify(groupResult('site'))))
    const out = await researchGroupHandler(ctx)
    expect(out.type).toBe('research_group.v1')
    expect(out.result).toEqual(groupResult('site'))
    expect(seen.map((s) => s.step)).toEqual(['site#0'])
    expect(seen[0]!.request.tools).toEqual([
      { type: 'web_search_20260209', maxUses: 20 },
      { type: 'web_fetch_20260209', maxUses: 30 },
    ])
    expect(seen[0]!.request.outputSchema).toBeUndefined()
  })

  it('a group reply with narration before the JSON is accepted', async () => {
    const text = `I read the site. Here is the result:\n${JSON.stringify(groupResult('site'))}`
    const { ctx } = stub({ group: 'site', intake }, () => ends(text))
    expect((await researchGroupHandler(ctx)).result).toEqual(groupResult('site'))
  })

  it('invisible characters in an extract or a flag reason are removed before validation', async () => {
    const dirty = groupResult('site', {
      sources: [source('s1', { extract: 'a\u200Bb\u202Ec', flagged: { reason: 'x\uFEFFy' } })],
    })
    const { ctx } = stub({ group: 'site', intake }, () => ends(JSON.stringify(dirty)))
    const out = (await researchGroupHandler(ctx)).result as ResearchGroupResult
    expect(out.sources[0]!.extract).toBe('abc')
    expect(out.sources[0]!.flagged).toEqual({ reason: 'xy' })
  })

  it.each([
    ['no JSON', 'nothing here'],
    ['a schema refusal', JSON.stringify({ group: 'site' })],
    ['another group', JSON.stringify(groupResult('social'))],
  ])('an invalid reply fails the attempt: %s', async (_name, text) => {
    const { ctx } = stub({ group: 'site', intake }, () => ends(text))
    await expect(researchGroupHandler(ctx)).rejects.toThrow(ResearchReplyInvalid)
  })

  it('an early stop fails the attempt and no partial result passes', async () => {
    const { ctx } = stub({ group: 'site', intake }, () => ({
      text: JSON.stringify(groupResult('site')),
      stopReason: 'max_tokens',
      content: [],
    }))
    await expect(researchGroupHandler(ctx)).rejects.toThrow(ModelStopped)
  })
})

describe('the documents group', () => {
  const MB8 = 8 * 1024 * 1024
  const part = (partNo: number) => ({
    partNo,
    firstPage: (partNo - 1) * 40 + 1,
    lastPage: partNo * 40,
    sizeBytes: MB8,
  })
  const big = {
    id: DOC,
    fileName: 'AZTEK BROCHURE.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 3 * MB8,
    parts: [part(1), part(2), part(3)],
  }
  const documentPart = async (_id: string, partNo: number) => ({
    firstPage: part(partNo).firstPage,
    lastPage: part(partNo).lastPage,
    bytes: Buffer.alloc(MB8),
  })
  // Each batch's reply cites one source per document block it was sent, as the label numbers them.
  const reply: Script = (_step, request) => {
    const content = request.messages[0]!.content as { type: string }[]
    const n = content.filter((b) => b.type === 'document' || b.type === 'image').length
    const sources = Array.from({ length: n }, (_v, i) =>
      source(`s${i + 1}`, { kind: 'document', address: null, documentId: DOC, extract: `part ${i + 1}` }),
    )
    return ends(
      JSON.stringify(
        groupResult('documents', {
          sources,
          findings: [
            finding(
              'what_they_sell',
              n === 2 ? 'Pumps' : ' pumps ',
              sources.map((x) => x.ref),
            ),
          ],
        }),
      ),
    )
  }

  it('batches by size and labels documents as data', async () => {
    const { ctx, seen } = stub({ group: 'documents', intake, documentIds: [DOC] }, reply, {
      documents: async () => [big],
      documentPart,
    })
    const out = await researchGroupHandler(ctx)
    expect(seen.map((s) => s.step)).toEqual(['documents#0', 'documents#1'])
    for (const s of seen) expect(s.request.tools).toBeUndefined()
    const blocks = (i: number) =>
      seen[i]!.request.messages[0]!.content as { type: string; text?: string; source?: { data: string } }[]
    expect(blocks(0).filter((b) => b.type === 'document')).toHaveLength(2)
    expect(blocks(1).filter((b) => b.type === 'document')).toHaveLength(1)
    const blockText = (i: number) =>
      blocks(i)
        .filter((b) => b.type === 'text')
        .map((b) => b.text!)
        .join('\n')
    const labels = blocks(0)
      .filter((b) => b.type === 'text')
      .map((b) => b.text!)
      .join('\n')
    expect(labels).toMatch(/untrusted/i)
    expect(labels).toContain('"AZTEK BROCHURE.pdf", pages 1–40')
    expect(labels).toContain('"AZTEK BROCHURE.pdf", pages 41–80')
    expect(blockText(1)).toContain('"AZTEK BROCHURE.pdf", pages 81–120')
    const total = (i: number) =>
      blocks(i).reduce((n, b) => n + (b.type === 'document' ? b.source!.data.length : 0), 0)
    expect(total(0)).toBeLessThanOrEqual(BATCH_MAX_BASE64)
    expect(total(0) + total(1)).toBeGreaterThan(BATCH_MAX_BASE64)
    for (const i of [0, 1])
      for (const b of blocks(i))
        if (b.type === 'document') expect(b.source!.data.length).toBeLessThanOrEqual(BATCH_MAX_BASE64)
    const result = out.result as ResearchGroupResult
    expect(researchGroupResultSchema.safeParse(result).success).toBe(true)
    // Renumbered across batches, a part's pages named in its address, equal findings joined.
    expect(result.sources.map((s) => s.ref)).toEqual(['s1', 's2', 's3'])
    expect(result.sources.map((s) => s.address)).toEqual([
      'AZTEK BROCHURE.pdf, pages 1–40',
      'AZTEK BROCHURE.pdf, pages 41–80',
      'AZTEK BROCHURE.pdf, pages 81–120',
    ])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.sourceRefs).toEqual(['s1', 's2', 's3'])
  })

  it('a document without parts is sent whole', async () => {
    const whole = {
      id: DOC2,
      fileName: 'one.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 5,
      parts: [],
    }
    const { ctx, seen } = stub(
      { group: 'documents', intake, documentIds: [DOC2] },
      () =>
        ends(
          JSON.stringify(
            groupResult('documents', {
              sources: [source('s1', { kind: 'document', address: null, documentId: DOC2 })],
            }),
          ),
        ),
      {
        documents: async () => [whole],
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('hello') }),
        documentPart: async () => {
          throw new Error('must not read a part')
        },
      },
    )
    const out = await researchGroupHandler(ctx)
    expect(seen).toHaveLength(1)
    const content = seen[0]!.request.messages[0]!.content as {
      type: string
      source?: { data: string }
    }[]
    expect(content.find((b) => b.type === 'document')!.source!.data).toBe(
      Buffer.from('hello').toString('base64'),
    )
    expect((out.result as ResearchGroupResult).sources[0]!.documentId).toBe(DOC2)
  })

  it('the documents group sends no tools', async () => {
    const png = {
      id: DOC2,
      fileName: 'logo.png',
      mediaType: 'image/png',
      sizeBytes: 3,
      parts: [],
    }
    const { ctx, seen } = stub({ group: 'documents', intake, documentIds: [DOC2] }, reply, {
      documents: async () => [png],
      document: async () => ({ mediaType: 'image/png', bytes: Buffer.from('abc') }),
    })
    await researchGroupHandler(ctx)
    expect(seen[0]!.request.tools).toBeUndefined()
    expect(seen[0]!.step).toBe('documents#0')
  })

  it('a job that lists no documents makes no model call', async () => {
    const { ctx, seen } = stub({ group: 'documents', intake }, reply)
    const out = await researchGroupHandler(ctx)
    expect(seen).toHaveLength(0)
    expect(out.result).toEqual({ group: 'documents', sources: [], findings: [], unsettled: [] })
  })

  it('an invalid reply fails the attempt', async () => {
    const { ctx } = stub(
      { group: 'documents', intake, documentIds: [DOC] },
      () => ends('{"group":"documents"}'),
      {
        documents: async () => [big],
        documentPart,
      },
    )
    await expect(researchGroupHandler(ctx)).rejects.toThrow(ResearchReplyInvalid)
  })
})

describe('joining document batch results', () => {
  const docSource = (ref: string, over: Record<string, unknown> = {}) =>
    source(ref, { kind: 'document', address: `f.pdf, pages ${ref}`, documentId: DOC, ...over })
  const parse = (value: unknown) => researchGroupResultSchema.parse(value)

  it('renumbers refs, joins equal findings and keeps the best confidence and any conflict', () => {
    const a = parse(
      groupResult('documents', {
        sources: [docSource('s1'), docSource('s2')],
        findings: [finding('what_they_sell', 'Pumps and  valves', ['s1'], { confidence: 'assumed' })],
      }),
    )
    const b = parse(
      groupResult('documents', {
        sources: [docSource('s1')],
        findings: [
          finding('what_they_sell', 'pumps and valves', ['s1'], { conflict: true }),
          finding('business_name', 'Aztek', ['s1']),
        ],
      }),
    )
    const joined = joinDocumentResults([a, b])
    expect(researchGroupResultSchema.safeParse(joined).success).toBe(true)
    expect(joined.findings).toEqual([
      finding('what_they_sell', 'Pumps and  valves', ['s1', 's2'], { conflict: true }),
      finding('business_name', 'Aztek', ['s2']),
    ])
    // Cited sources first; the uncited s2 of batch a follows while there is room (R27a); all renumbered.
    expect(joined.sources.map((s) => s.ref)).toEqual(['s1', 's2', 's3'])
  })

  it('keeps 40 findings, moves the keys of the rest to unsettled and caps sources at 60', () => {
    const many = Array.from({ length: 40 }, (_v, i) => finding('business_name', `Name ${i}`, [`s${i + 1}`]))
    const sources = Array.from({ length: 40 }, (_v, i) => docSource(`s${i + 1}`))
    const extra = parse(
      groupResult('documents', {
        sources,
        findings: many,
        unsettled: [{ key: 'tone_of_voice', why: 'Not stated.' }],
      }),
    )
    const second = parse(
      groupResult('documents', {
        sources: [docSource('s1')],
        findings: [finding('certifications', 'ISO 9001', ['s1'])],
        unsettled: [{ key: 'business_name', why: 'Seen too late.' }],
      }),
    )
    const joined = joinDocumentResults([extra, second])
    expect(researchGroupResultSchema.safeParse(joined).success).toBe(true)
    expect(joined.findings).toHaveLength(40)
    expect(joined.findings.some((f) => f.key === 'certifications')).toBe(false)
    expect(joined.unsettled).toEqual([
      { key: 'tone_of_voice', why: 'Not stated.' },
      { key: 'certifications', why: 'More document findings than one result holds; ask the owner.' },
    ])
    // 40 cited, then batch two's uncited source while there is room.
    expect(joined.sources).toHaveLength(41)

    // Flagged sources come after cited ones, up to 60 in all.
    const flagged = (ref: string) => docSource(ref, { flagged: { reason: 'Unverifiable award.' } })
    const crowded = parse(
      groupResult('documents', {
        sources: [
          ...Array.from({ length: 30 }, (_v, i) => docSource(`s${i + 1}`)),
          ...Array.from({ length: 30 }, (_v, i) => flagged(`s${i + 31}`)),
        ],
        findings: Array.from({ length: 30 }, (_v, i) => finding('business_name', `N${i}`, [`s${i + 1}`])),
      }),
    )
    const more = parse(groupResult('documents', { sources: [flagged('s1'), flagged('s2')], findings: [] }))
    const out = joinDocumentResults([crowded, more])
    expect(researchGroupResultSchema.safeParse(out).success).toBe(true)
    expect(out.sources).toHaveLength(60)
    expect(out.sources.slice(30).every((s) => s.flagged !== null)).toBe(true)
  })
})

describe('the merge handler', () => {
  const mergeInput = {
    groups: [
      {
        group: 'site',
        sources: [
          {
            id: DOC,
            kind: 'site',
            address: 'https://shop.example/',
            result: 'read',
            extract: 'x',
            flagged: null,
          },
        ],
        findings: [],
      },
    ],
    deadGroups: [],
  }

  it('sends no tools and returns a valid research result', async () => {
    const good = { suggestions: [], gaps: [{ key: 'tone_of_voice', why: 'Not found.' }] }
    const { ctx, seen } = stub(mergeInput, () => ends(JSON.stringify(good)))
    const out = await researchMergeHandler(ctx)
    expect(out).toEqual({ type: 'research.v1', result: good })
    expect(seen.map((s) => s.step)).toEqual(['merge'])
    expect(seen[0]!.request.tools).toBeUndefined()
    expect(seen[0]!.request.outputSchema).toBeDefined()
  })

  it('an invalid reply fails the attempt', async () => {
    const { ctx } = stub(mergeInput, () => ends('{"suggestions":"no"}'))
    await expect(researchMergeHandler(ctx)).rejects.toThrow(ResearchReplyInvalid)
    const bad = stub(mergeInput, () => ends('not json'))
    await expect(researchMergeHandler(bad.ctx)).rejects.toThrow(ResearchReplyInvalid)
  })
})

const C = String.fromCharCode
const REPAIR_GOOD = JSON.stringify(groupResult('site'))

describe('invisible characters in group replies', () => {
  const run = async (extract: string) => {
    const dirty = groupResult('site', { sources: [source('s1', { extract })] })
    const { ctx } = stub({ group: 'site', intake }, () => ends(JSON.stringify(dirty)))
    return ((await researchGroupHandler(ctx)).result as ResearchGroupResult).sources[0]!.extract
  }
  it('direction isolates and the Arabic letter mark are removed', async () => {
    expect(await run(`a${C(0x2067)}b${C(0x2069)}c${C(0x61c)}d`)).toBe('abcd')
  })
  it('the joiner and non-joiner stay, as in the shared rule', async () => {
    const hindi = C(0x915, 0x94d, 0x200d, 0x937)
    expect(await run(hindi)).toBe(hindi)
  })
})

describe('file names', () => {
  const LRM = C(0x200e)
  it('a name with direction marks gives a valid result and a clean label', async () => {
    const doc = {
      id: DOC2,
      fileName: `a${LRM}b${LRM}c.pdf`,
      mediaType: 'application/pdf',
      sizeBytes: 5,
      parts: [],
    }
    const { ctx, seen } = stub(
      { group: 'documents', intake, documentIds: [DOC2] },
      () =>
        ends(
          JSON.stringify(
            groupResult('documents', {
              sources: [source('s1', { kind: 'document', address: null, documentId: DOC2 })],
            }),
          ),
        ),
      {
        documents: async () => [doc],
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('x') }),
      },
    )
    const out = await researchGroupHandler(ctx)
    expect(researchGroupResultSchema.safeParse(out.result).success).toBe(true)
    expect((out.result as ResearchGroupResult).sources[0]!.address).toBe('a b c.pdf')
    expect(JSON.stringify(seen[0]!.request.messages)).not.toContain(LRM)
  })
  it('a name that is only invisible characters falls back to the document id', async () => {
    const doc = { id: DOC2, fileName: LRM + LRM, mediaType: 'application/pdf', sizeBytes: 5, parts: [] }
    const { ctx } = stub(
      { group: 'documents', intake, documentIds: [DOC2] },
      () =>
        ends(
          JSON.stringify(
            groupResult('documents', {
              sources: [source('s1', { kind: 'document', address: null, documentId: DOC2 })],
            }),
          ),
        ),
      {
        documents: async () => [doc],
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('x') }),
      },
    )
    const out = await researchGroupHandler(ctx)
    expect((out.result as ResearchGroupResult).sources[0]!.address).toBe(DOC2)
  })
})

describe('the attempt deadline', () => {
  const doc = { id: DOC2, fileName: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 5, parts: [] }
  it('a documents job with 45 seconds left stops before any model call', async () => {
    const { ctx, seen } = stub({ group: 'documents', intake, documentIds: [DOC2] }, () => ends('{}'), {
      deadline: new Date(Date.now() + 45_000),
      documents: async () => [doc],
      document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('x') }),
    })
    await expect(researchGroupHandler(ctx)).rejects.toThrow(ModelStopped)
    expect(seen).toHaveLength(0)
  })
  it('the merge step stops the same way and a request carries a timeout inside the budget', async () => {
    const early = stub(mergeInputFor(), () => ends('{}'), { deadline: new Date(Date.now() + 45_000) })
    await expect(researchMergeHandler(early.ctx)).rejects.toThrow(ModelStopped)
    expect(early.seen).toHaveLength(0)
    const ok = stub(mergeInputFor(), () => ends(JSON.stringify({ suggestions: [], gaps: [] })))
    await researchMergeHandler(ok.ctx)
    expect(ok.seen[0]!.request.timeoutMs).toBeGreaterThan(0)
  })
})

describe('one repair request for an invalid reply', () => {
  it('invalid then valid succeeds with exactly one repair call', async () => {
    const { ctx, seen } = stub({ group: 'site', intake }, (step) =>
      ends(step === 'site#repair' ? REPAIR_GOOD : 'I could not format it'),
    )
    const out = await researchGroupHandler(ctx)
    expect(out.result).toEqual(groupResult('site'))
    expect(seen.map((x) => x.step)).toEqual(['site#0', 'site#repair'])
    const repair = seen[1]!.request
    expect(repair.tools).toBeUndefined()
    expect(repair.system).toBe(seen[0]!.request.system)
    const text = JSON.stringify(repair.messages)
    expect(text).toContain('I could not format it')
    expect(text).toMatch(/untrusted|data/i)
  })
  it('invalid then invalid throws', async () => {
    const { ctx, seen } = stub({ group: 'site', intake }, () => ends('nope'))
    await expect(researchGroupHandler(ctx)).rejects.toThrow(ResearchReplyInvalid)
    expect(seen.map((x) => x.step)).toEqual(['site#0', 'site#repair'])
  })
  it('a schema failure is described to the model without quoting values', async () => {
    const { ctx, seen } = stub({ group: 'site', intake }, (step) =>
      ends(step === 'site#repair' ? REPAIR_GOOD : JSON.stringify({ group: 'site', secret: 'LEAK' })),
    )
    await researchGroupHandler(ctx)
    const repair = seen[1]!.request.messages[0]!.content as string
    expect(repair).toMatch(/sources|findings/)
  })
  it('a documents batch is repaired as documents#k#repair, and the merge as merge#repair', async () => {
    const doc = { id: DOC2, fileName: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 5, parts: [] }
    const docs = stub(
      { group: 'documents', intake, documentIds: [DOC2] },
      (step) =>
        ends(
          step.endsWith('#repair')
            ? JSON.stringify(
                groupResult('documents', {
                  sources: [source('s1', { kind: 'document', address: null, documentId: DOC2 })],
                }),
              )
            : 'bad',
        ),
      {
        documents: async () => [doc],
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('x') }),
      },
    )
    await researchGroupHandler(docs.ctx)
    expect(docs.seen.map((x) => x.step)).toEqual(['documents#0', 'documents#0#repair'])
    expect(docs.seen[1]!.request.tools).toBeUndefined()
    const merge = stub(mergeInputFor(), (step) =>
      ends(step === 'merge#repair' ? JSON.stringify({ suggestions: [], gaps: [] }) : 'bad'),
    )
    await researchMergeHandler(merge.ctx)
    expect(merge.seen.map((x) => x.step)).toEqual(['merge', 'merge#repair'])
  })
  it('a retried attempt asks for the same steps with the same requests', async () => {
    const attempt = async () => {
      const run = stub({ group: 'site', intake }, (step) =>
        ends(step === 'site#repair' ? REPAIR_GOOD : 'bad'),
      )
      await researchGroupHandler(run.ctx)
      // The timeout varies with the clock and is not part of the request hash.
      return run.seen.map((x) => [x.step, JSON.stringify({ ...x.request, timeoutMs: 0 })])
    }
    const first = await attempt()
    expect(first.map((x) => x[0])).toEqual(['site#0', 'site#repair'])
    expect(await attempt()).toEqual(first)
  })
})

describe('batching limits', () => {
  const MB = 1024 * 1024
  const run = async (docs: unknown[], parts: Record<string, number> = {}) => {
    const { ctx, seen } = stub(
      { group: 'documents', intake },
      (_s, request) => {
        const content = request.messages[0]!.content as { type: string }[]
        const n = content.filter((b) => b.type === 'document').length
        return ends(
          JSON.stringify(
            groupResult('documents', {
              sources: Array.from({ length: n }, (_v, i) =>
                source(`s${i + 1}`, { kind: 'document', address: null, documentId: DOC }),
              ),
            }),
          ),
        )
      },
      {
        documents: async () => docs as never,
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.alloc(10) }),
        documentPart: async (_id, partNo) => ({
          firstPage: parts[partNo] ?? 1,
          lastPage: parts[partNo] ?? 1,
          bytes: Buffer.alloc(10),
        }),
      },
    )
    await researchGroupHandler(ctx)
    return seen
  }
  it('the 100-page cap alone splits small parts of 60 pages', async () => {
    const part = (n: number) => ({ partNo: n, firstPage: (n - 1) * 60 + 1, lastPage: n * 60, sizeBytes: MB })
    const seen = await run([
      {
        id: DOC,
        fileName: 'big.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 2 * MB,
        parts: [part(1), part(2)],
      },
    ])
    expect(seen.map((x) => x.step)).toEqual(['documents#0', 'documents#1'])
  })
  it('two whole PDFs make two batches', async () => {
    const whole = (id: string) => ({
      id,
      fileName: 'w.pdf',
      mediaType: 'application/pdf',
      sizeBytes: 10,
      parts: [],
    })
    const seen = await run([whole(DOC), whole(DOC2)])
    expect(seen).toHaveLength(2)
  })
})

describe('joining keeps what the owner should see', () => {
  const docSource = (ref: string, over: Record<string, unknown> = {}) =>
    source(ref, { kind: 'document', address: `f.pdf ${ref}`, documentId: DOC, ...over })
  it('keeps blocked and error records after cited and flagged ones while there is room', () => {
    const r = researchGroupResultSchema.parse(
      groupResult('documents', {
        sources: [
          docSource('s1', { result: 'blocked' }),
          docSource('s2', { result: 'error' }),
          docSource('s3'),
        ],
        findings: [finding('business_name', 'Shop', ['s3'])],
      }),
    )
    const out = joinDocumentResults([r])
    expect(out.sources.map((x) => x.result)).toEqual(['read', 'blocked', 'error'])
  })
  it('a source outside the batch is dropped and a finding left without sources becomes unsettled', async () => {
    const doc = { id: DOC2, fileName: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 5, parts: [] }
    const { ctx } = stub(
      { group: 'documents', intake, documentIds: [DOC2] },
      () =>
        ends(
          JSON.stringify(
            groupResult('documents', {
              sources: [
                source('s1', { kind: 'document', address: null, documentId: DOC2 }),
                source('s9', { kind: 'document', address: null, documentId: DOC2 }),
              ],
              findings: [finding('business_name', 'Shop', ['s1']), finding('certifications', 'ISO', ['s9'])],
            }),
          ),
        ),
      {
        documents: async () => [doc],
        document: async () => ({ mediaType: 'application/pdf', bytes: Buffer.from('x') }),
      },
    )
    const result = (await researchGroupHandler(ctx)).result as ResearchGroupResult
    expect(result.sources).toHaveLength(1)
    expect(result.findings.map((f) => f.key)).toEqual(['business_name'])
    expect(result.unsettled.map((u) => u.key)).toContain('certifications')
  })
})

describe('the research definition caps', () => {
  it('a definition without the per-job caps is refused', () => {
    expect(() => requireCaps({ caps: { searchesPerJob: 20 } } as never)).toThrow(/fetchesPerJob/)
    expect(requireCaps({ caps: { searchesPerJob: 20, fetchesPerJob: 30 } } as never)).toEqual({
      searches: 20,
      fetches: 30,
    })
  })
})

function mergeInputFor() {
  return {
    groups: [
      {
        group: 'site',
        sources: [
          {
            id: DOC,
            kind: 'site',
            address: 'https://shop.example/',
            result: 'read',
            extract: 'x',
            flagged: null,
          },
        ],
        findings: [],
      },
    ],
    deadGroups: [],
  }
}
