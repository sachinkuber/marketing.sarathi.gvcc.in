'use client'
import { useParams } from 'next/navigation'
import { isUuid } from '../../../../api/ids'
import { Frame } from '../../../../frame/Frame'

export default function BrandLayout({ children }: { children: React.ReactNode }) {
  const { brand } = useParams<{ brand: string }>()
  // The id goes into API paths, so anything that is not a uuid is a missing address, not a request.
  if (!isUuid(brand)) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          <b>There is nothing at this address.</b>
        </div>
      </main>
    )
  }
  return <Frame brandId={brand}>{children}</Frame>
}
