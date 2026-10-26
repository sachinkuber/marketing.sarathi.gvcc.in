'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { api } from '../api/client'
import { brandsReply, homeReply } from '../api/schemas'
import { useLoad } from '../api/use-load'
import { Empty } from '../frame/Empty'
import { LoadError } from '../frame/LoadError'
import { useShell } from '../frame/shell-context'
import { formatMicros, waitedFor, words } from './format'
import { hasProblems, type Home } from './HomeBlocks'

export interface BrandRow {
  brand: { id: string; name: string; slug: string; status: string }
  // Null when this brand's figures could not be read; the other brands still show.
  home: Home | null
}

function figures(home: Home, now: number): string[] {
  const out: string[] = []
  if (home.results) {
    out.push(`${home.results.runsThisMonth} ${home.results.runsThisMonth === 1 ? 'run' : 'runs'} this month`)
    out.push(
      `${formatMicros(home.results.costThisMonth.usdMicros, 'USD')} (${formatMicros(home.results.costThisMonth.inrMicros, 'INR')})`,
    )
  }
  if (home.waiting) {
    const { awaitingApproval, oldestWaitingSince } = home.waiting
    out.push(
      oldestWaitingSince
        ? `${awaitingApproval} awaiting approval, the oldest for ${waitedFor(oldestWaitingSince, now)}`
        : `${awaitingApproval} awaiting approval`,
    )
  }
  if (hasProblems(home.problems)) {
    const { deadJobs, openAlerts, reviewCalls } = home.problems
    out.push(`${deadJobs + openAlerts + reviewCalls} problems`)
  }
  return out
}

// Every brand the person can open, each with its home figures (the platform owner sees them all).
export function AllBrandsList({ rows, now }: { rows: BrandRow[]; now: number }) {
  return (
    <div className="panel">
      <ul className="list">
        {rows.map(({ brand, home }) => (
          <li key={brand.id} className="wrap-row">
            <div className="grow">
              <b>
                <Link href={`/b/${brand.id}`}>{brand.name}</Link>
              </b>
              <div className="muted small">
                {home ? figures(home, now).join(' · ') : 'Could not load the figures for this brand.'}
              </div>
            </div>
            <span className={`tag ${brand.status === 'active' ? 'ok' : ''}`}>{words(brand.status)}</span>
            {home && hasProblems(home.problems) ? <span className="tag danger">Problems</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

async function loadRows(): Promise<BrandRow[]> {
  const { brands } = await api(brandsReply, 'GET', '/brands')
  const homes = await Promise.allSettled(
    brands.map((brand) => api(homeReply, 'GET', `/brands/${brand.id}/home`)),
  )
  return brands.map((brand, i) => {
    const home = homes[i]
    return {
      brand: { id: brand.id, name: brand.name, slug: brand.slug, status: brand.status },
      home: home?.status === 'fulfilled' ? home.value : null,
    }
  })
}

// The front page and /brands. With `single` set, someone who belongs to exactly one brand (and is not the
// platform owner) goes straight to that brand's Home instead of a list of one.
export function AllBrandsScreen({ single }: { single: boolean }) {
  const router = useRouter()
  const { session } = useShell()
  const loaded = useLoad(loadRows, 'brands')
  const only =
    single && !session.platformOwner && loaded.state === 'ready' && loaded.data.length === 1
      ? loaded.data[0]
      : undefined
  useEffect(() => {
    if (only) router.replace(`/b/${only.brand.id}`)
  }, [only, router])

  if (loaded.state === 'error') {
    return (
      <main id="content" className="page">
        <LoadError what="your brands" error={loaded.error} onRetry={loaded.retry} />
      </main>
    )
  }
  if (loaded.state === 'loading' || only) return <p className="page muted">Loading…</p>
  return (
    <main id="content" className="page">
      <div className="page-head">
        <div>
          <h1>All brands</h1>
          <p>Each brand’s figures for this month. Open a brand for its home, inbox and settings.</p>
        </div>
      </div>
      {loaded.data.length === 0 ? (
        <Empty title="No brand yet">
          {session.platformOwner ? 'No brand has been created yet.' : 'You are not a member of any brand.'}
        </Empty>
      ) : (
        <AllBrandsList rows={loaded.data} now={Date.now()} />
      )}
    </main>
  )
}
