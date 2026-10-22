import type { z } from 'zod'
import type { overdueAllReply } from '../api/schemas'
import type { BrandSummary } from './BrandSwitcher'

export type OverdueAll = z.infer<typeof overdueAllReply>
export type OverdueBrand = OverdueAll['brands'][number]

interface WhoAmI {
  platformOwner: boolean
  memberships: Array<{ brandId: string; role: string }>
}

// Only someone who can approve anywhere has overdue items to hear about; the core answers an empty list to
// everyone else, so not asking saves a request a minute.
export function shouldPollOverdue(who: WhoAmI): boolean {
  return who.platformOwner || who.memberships.some((m) => m.role === 'approver' || m.role === 'brand_admin')
}

// The brand switcher is for the platform owner only; everyone else is fixed to their brand.
export function switcherBrands(
  who: Pick<WhoAmI, 'platformOwner'>,
  brands: BrandSummary[] | null,
): BrandSummary[] | null {
  return who.platformOwner ? brands : null
}

// Dead letters are the platform owner's: the core refuses everyone else (see_other_brands), so links to them
// are shown to the owner only.
export function canSeeDeadLetters(who: Pick<WhoAmI, 'platformOwner'>): boolean {
  return who.platformOwner
}

// The pop-up is for the first brand whose pop-up is due.
export function popupTarget(overdue: OverdueAll | null): OverdueBrand | null {
  return overdue?.brands.find((brand) => brand.popupDue) ?? null
}

export interface KeyAction {
  prevent: boolean
  focus: 'first' | 'last' | 'dialog' | null
}

// What the pop-up does with a key. Escape is swallowed. Tab never leaves the dialog: it cycles over the enabled
// buttons, and with none enabled (an answer is being saved) focus stays on the dialog itself.
export function popupKeyAction(
  key: string,
  shift: boolean,
  active: 'first' | 'last' | 'other' | 'none',
  buttonCount: number,
): KeyAction {
  if (key === 'Escape') return { prevent: true, focus: null }
  if (key !== 'Tab') return { prevent: false, focus: null }
  if (buttonCount === 0) return { prevent: true, focus: 'dialog' }
  if (active === 'other' || active === 'none') return { prevent: true, focus: shift ? 'last' : 'first' }
  if (shift && active === 'first') return { prevent: true, focus: 'last' }
  if (!shift && active === 'last') return { prevent: true, focus: 'first' }
  return { prevent: false, focus: null }
}

// Where the stop button leads on a screen that belongs to no single brand: the safety screen of the one brand
// an admin manages, else the list of brands (the owner, or an admin of several). Null when the person cannot stop.
export function stopTarget(who: WhoAmI): string | null {
  if (who.platformOwner) return '/brands'
  const admin = who.memberships.filter((m) => m.role === 'brand_admin')
  if (admin.length === 0) return null
  const only = admin[0]
  return admin.length === 1 && only ? `/b/${only.brandId}/settings/safety` : '/brands'
}
