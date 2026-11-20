'use client'
import { useParams } from 'next/navigation'
import { ResearchProgressScreen } from '../../../../../../screens/ResearchProgress'

export default function ResearchProgressPage() {
  const { brand } = useParams<{ brand: string }>()
  return <ResearchProgressScreen brandId={brand} />
}
