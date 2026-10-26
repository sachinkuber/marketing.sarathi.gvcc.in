'use client'
import { useParams } from 'next/navigation'
import { ApprovalSettingsScreen } from '../../../../../../screens/ApprovalSettings'

export default function ApprovalSettingsPage() {
  const { brand } = useParams<{ brand: string }>()
  return <ApprovalSettingsScreen brandId={brand} />
}
