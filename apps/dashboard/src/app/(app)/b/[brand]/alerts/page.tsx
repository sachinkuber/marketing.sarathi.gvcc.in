'use client'
import { useParams } from 'next/navigation'
import { BrandAlertsScreen } from '../../../../../screens/Alerts'

export default function BrandAlertsPage() {
  const { brand } = useParams<{ brand: string }>()
  return <BrandAlertsScreen brandId={brand} />
}
