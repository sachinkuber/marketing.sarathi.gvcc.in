'use client'
import { useParams } from 'next/navigation'
import { BriefChoicesScreen } from '../../../../../../screens/BriefChoices'

export default function BriefChoicesPage() {
  const { brand } = useParams<{ brand: string }>()
  return <BriefChoicesScreen brandId={brand} />
}
