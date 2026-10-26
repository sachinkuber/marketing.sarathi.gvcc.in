'use client'
import { useParams } from 'next/navigation'
import { UsersScreen } from '../../../../../../screens/Users'

export default function UsersPage() {
  const { brand } = useParams<{ brand: string }>()
  return <UsersScreen brandId={brand} />
}
