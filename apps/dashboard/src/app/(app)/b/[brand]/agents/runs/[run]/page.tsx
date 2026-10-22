'use client'
import { useParams } from 'next/navigation'
import { isUuid } from '../../../../../../../api/ids'
import { RunScreen } from '../../../../../../../screens/RunDetail'

export default function RunPage() {
  const { brand, run } = useParams<{ brand: string; run: string }>()
  // The run id goes into API paths, so anything that is not a uuid is a missing address, not a request.
  if (!isUuid(run)) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          <b>There is nothing at this address.</b>
        </div>
      </main>
    )
  }
  return <RunScreen brandId={brand} runId={run} />
}
