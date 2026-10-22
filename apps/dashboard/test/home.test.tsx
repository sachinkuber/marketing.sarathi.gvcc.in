import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HomeBlocks } from '../src/screens/HomeBlocks'
import { AllBrandsList } from '../src/screens/AllBrands'
import { formatMicros } from '../src/screens/format'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const brandId = '6c77c301-7cb4-4c81-8551-1a0fbe6dce41'

const full = {
  results: {
    runsThisMonth: 4,
    costThisMonth: { usdMicros: '1234567', inrMicros: '102469061' },
    lastRuns: [],
  },
  progress: { jobs: { waiting: 1, running: 2, held: 0, dead: 1, finished: 9 } },
  waiting: { awaitingApproval: 3, oldestWaitingSince: '2026-10-18T12:00:00.000Z' },
  problems: { deadJobs: 1, openAlerts: 2, reviewCalls: 0 },
}

const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1])

describe('the home screen', () => {
  it('shows the four blocks in order: results, progress, waiting for you, problems', () => {
    const html = renderToStaticMarkup(<HomeBlocks brandId={brandId} home={full} now={NOW} />)
    expect(headings(html)).toEqual(['Results', 'Progress', 'Waiting for you', 'Problems'])
    expect(html).toContain('$1.234567')
    expect(html).toContain('3 items')
    expect(html).toContain(`href="/b/${brandId}/inbox"`)
  })

  it('leaves out a block whose data is null for the role', () => {
    const viewer = { ...full, results: null, progress: null, waiting: null }
    expect(headings(renderToStaticMarkup(<HomeBlocks brandId={brandId} home={viewer} now={NOW} />))).toEqual([
      'Problems',
    ])
    const approver = { ...full, results: null, progress: null }
    expect(
      headings(renderToStaticMarkup(<HomeBlocks brandId={brandId} home={approver} now={NOW} />)),
    ).toEqual(['Waiting for you', 'Problems'])
  })

  it('shows problems only when a count is above zero', () => {
    const calm = { ...full, problems: { deadJobs: 0, openAlerts: 0, reviewCalls: 0 } }
    const html = renderToStaticMarkup(<HomeBlocks brandId={brandId} home={calm} now={NOW} />)
    expect(headings(html)).toEqual(['Results', 'Progress', 'Waiting for you'])
    const one = { ...full, problems: { deadJobs: 0, openAlerts: 0, reviewCalls: 1 } }
    expect(headings(renderToStaticMarkup(<HomeBlocks brandId={brandId} home={one} now={NOW} />))).toContain(
      'Problems',
    )
  })

  it('says nothing waits when the queue is empty', () => {
    const empty = { ...full, waiting: { awaitingApproval: 0, oldestWaitingSince: null } }
    expect(renderToStaticMarkup(<HomeBlocks brandId={brandId} home={empty} now={NOW} />)).toContain(
      'Nothing is waiting for your approval',
    )
  })

  it('lists every brand with its figures for the owner', () => {
    const html = renderToStaticMarkup(
      <AllBrandsList
        now={NOW}
        rows={[
          { brand: { id: brandId, name: 'Aztek Global', slug: 'aztek', status: 'active' }, home: full },
          {
            brand: {
              id: '7c77c301-7cb4-4c81-8551-1a0fbe6dce41',
              name: 'Test brand',
              slug: 't',
              status: 'active',
            },
            home: null,
          },
        ]}
      />,
    )
    expect(html).toContain('Aztek Global')
    expect(html).toContain('Test brand')
    expect(html).toContain(`href="/b/${brandId}"`)
    expect(html).toContain('3 awaiting approval')
    expect(html).toContain('Could not load the figures')
    expect(html).not.toMatch(/\sstyle=/)
  })
})

describe('money from millionths', () => {
  it('formats without going through floating point', () => {
    expect(formatMicros('1234567', 'USD')).toBe('$1.234567')
    expect(formatMicros('0', 'USD')).toBe('$0.000000')
    expect(formatMicros('123456789000001', 'INR')).toBe('₹12,34,56,789.000001')
    expect(formatMicros('9007199254740993000000', 'USD')).toBe('$9,007,199,254,740,993.000000')
  })
})
