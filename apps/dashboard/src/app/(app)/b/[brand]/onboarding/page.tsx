'use client'
import { useParams } from 'next/navigation'
import { OnboardingScreen } from '../../../../../screens/Onboarding'

export default function OnboardingPage() {
  const { brand } = useParams<{ brand: string }>()
  return <OnboardingScreen brandId={brand} />
}
