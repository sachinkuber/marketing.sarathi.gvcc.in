'use client'
import { useParams } from 'next/navigation'
import { isUuid } from '../../../../../../api/ids'
import { ItemScreen } from '../../../../../../screens/ItemScreen'

export default function ItemPage() {
  const { brand, item } = useParams<{ brand: string; item: string }>()
  // The item id goes into API paths, so anything that is not a uuid is a missing address, not a request.
  if (!isUuid(item)) {
    return (
      <main id="content" className="page">
        <div className="callout warn" role="alert">
          <b>There is nothing at this address.</b>
        </div>
      </main>
    )
  }
  return <ItemScreen brandId={brand} itemId={item} />
}
