'use client'
import { useParams } from 'next/navigation'
import { BrandHome } from '../../../../screens/BrandHome'

export default function BrandHomePage() {
  const { brand } = useParams<{ brand: string }>()
  return <BrandHome brandId={brand} />
}
