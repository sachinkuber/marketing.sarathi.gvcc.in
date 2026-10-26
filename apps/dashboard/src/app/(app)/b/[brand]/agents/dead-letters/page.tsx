'use client'
import { useParams } from 'next/navigation'
import { DeadLettersScreen } from '../../../../../../screens/DeadLetters'

export default function DeadLettersPage() {
  const { brand } = useParams<{ brand: string }>()
  return <DeadLettersScreen brandId={brand} />
}
