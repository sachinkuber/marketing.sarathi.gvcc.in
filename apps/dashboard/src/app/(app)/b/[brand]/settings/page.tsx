'use client'
import { useParams } from 'next/navigation'
import { BrandSettingsScreen } from '../../../../../screens/BrandSettings'

export default function BrandSettingsPage() {
  const { brand } = useParams<{ brand: string }>()
  return <BrandSettingsScreen brandId={brand} />
}
