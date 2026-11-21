'use client'
import { useParams } from 'next/navigation'
import { FactsRulesScreen } from '../../../../../../screens/FactsRules'

export default function FactsRulesPage() {
  const { brand } = useParams<{ brand: string }>()
  return <FactsRulesScreen brandId={brand} />
}
