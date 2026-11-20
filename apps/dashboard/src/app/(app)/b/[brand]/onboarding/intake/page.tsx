'use client'
import { useParams } from 'next/navigation'
import { OnboardingIntakeScreen } from '../../../../../../screens/OnboardingIntake'

export default function OnboardingIntakePage() {
  const { brand } = useParams<{ brand: string }>()
  return <OnboardingIntakeScreen brandId={brand} />
}
