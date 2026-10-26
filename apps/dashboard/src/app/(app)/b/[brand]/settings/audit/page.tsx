'use client'
import { useParams } from 'next/navigation'
import { AuditScreen } from '../../../../../../screens/Audit'

export default function AuditPage() {
  const { brand } = useParams<{ brand: string }>()
  return <AuditScreen brandId={brand} />
}
