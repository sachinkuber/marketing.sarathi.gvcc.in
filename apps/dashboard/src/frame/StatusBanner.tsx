import Link from 'next/link'
import type { z } from 'zod'
import type { statusReply } from '../api/schemas'

export type Status = z.infer<typeof statusReply>

// The coloured bars across the top of every brand screen: kill switch (red), shadow mode and overdue
// approvals (amber). "Later" on the pop-up never removes the overdue bar; only a decision does.
export function StatusBanner(props: {
  brandId: string
  brandName: string
  status: Status | null
  overdueCount: number
}) {
  const { brandId, brandName, status, overdueCount } = props
  const bars: React.ReactNode[] = []
  if (status?.killSwitch.active) {
    bars.push(
      <div className="banner danger" role="alert" key="kill">
        <b>Kill switch is on for {brandName}.</b> Waiting work is held and nothing is being sent.
        <Link href={`/b/${brandId}/settings/safety`}>Review and release</Link>
      </div>,
    )
  }
  if (status?.shadowMode) {
    bars.push(
      <div className="banner warn" key="shadow">
        <b>Shadow mode is on.</b> Everything is produced and approved as usual, and nothing is published.
        <Link href={`/b/${brandId}/settings/safety`}>Settings</Link>
      </div>,
    )
  }
  if (overdueCount > 0) {
    bars.push(
      <div className="banner warn" key="overdue">
        <b>
          {overdueCount} {overdueCount === 1 ? 'item' : 'items'} overdue for approval
        </b>
        <span>They stay unapproved and unpublished until someone decides.</span>
        <Link href={`/b/${brandId}/inbox?filter=overdue`}>Review overdue items</Link>
      </div>,
    )
  }
  if (bars.length === 0) return null
  return <div className="banners">{bars}</div>
}
