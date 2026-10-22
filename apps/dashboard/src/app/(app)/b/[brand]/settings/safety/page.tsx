'use client'
import { useParams } from 'next/navigation'
import { SafetyScreen } from '../../../../../../screens/Safety'

export default function SafetyPage() {
  const { brand } = useParams<{ brand: string }>()
  return <SafetyScreen brandId={brand} />
}
