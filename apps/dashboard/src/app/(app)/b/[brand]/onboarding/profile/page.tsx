'use client'
import { useParams } from 'next/navigation'
import { DraftProfileScreen } from '../../../../../../screens/DraftProfile'

export default function DraftProfilePage() {
  const { brand } = useParams<{ brand: string }>()
  return <DraftProfileScreen brandId={brand} />
}
