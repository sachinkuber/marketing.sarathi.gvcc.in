'use client'
import { useParams } from 'next/navigation'
import { use } from 'react'
import { InboxScreen, inboxFilter } from '../../../../../screens/Inbox'

export default function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { brand } = useParams<{ brand: string }>()
  const { filter } = use(searchParams)
  return <InboxScreen brandId={brand} filter={inboxFilter(typeof filter === 'string' ? filter : null)} />
}
