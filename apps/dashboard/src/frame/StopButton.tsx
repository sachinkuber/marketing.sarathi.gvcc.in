import Link from 'next/link'

export function StopButton({ brandId, canStop }: { brandId: string; canStop: boolean }) {
  if (!canStop) return null
  return (
    <Link className="stopbtn" href={`/b/${brandId}/settings/safety`} title="Stop activity for this brand">
      Stop
    </Link>
  )
}
