'use client'
import { useParams } from 'next/navigation'
import { AgentsScreen } from '../../../../../screens/Agents'

export default function AgentsPage() {
  const { brand } = useParams<{ brand: string }>()
  return <AgentsScreen brandId={brand} />
}
