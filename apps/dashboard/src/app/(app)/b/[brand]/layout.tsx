'use client'
import { useParams } from 'next/navigation'
import { Frame } from '../../../frame/Frame'

export default function BrandLayout({ children }: { children: React.ReactNode }) {
  const { brand } = useParams<{ brand: string }>()
  return <Frame brandId={brand}>{children}</Frame>
}
