import type { z } from 'zod'
import type { brandSummary } from '../api/schemas'

export type BrandSummary = z.infer<typeof brandSummary>

// Only the platform owner gets this; everyone else is fixed to their brand.
export function BrandSwitcher(props: {
  brands: BrandSummary[]
  currentId: string
  onSwitch: (target: string | null) => void
}) {
  return (
    <label className="brandswitch">
      <span className="tiny muted">Brand</span>
      <select
        className="input"
        value={props.currentId}
        onChange={(event) => props.onSwitch(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">All brands</option>
        {props.brands.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>
    </label>
  )
}
