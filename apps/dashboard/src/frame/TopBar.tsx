import { BrandSwitcher, type BrandSummary } from './BrandSwitcher'
import { StopButton } from './StopButton'

export function TopBar(props: {
  brandId: string
  brandName: string
  userName: string
  brands: BrandSummary[] | null
  canStop: boolean
  onSwitch: (target: string | null) => void
  onSignOut: () => void
}) {
  return (
    <header className="topbar">
      <div className="where">
        Marketing platform <span>/ {props.brandName}</span>
      </div>
      {props.brands ? (
        <BrandSwitcher brands={props.brands} currentId={props.brandId} onSwitch={props.onSwitch} />
      ) : null}
      <div className="sp" />
      <StopButton brandId={props.brandId} canStop={props.canStop} />
      <div className="userchip">
        <span className="avatar">{props.userName.slice(0, 1).toUpperCase()}</span>
        <span>{props.userName}</span>
      </div>
      <button className="btn sm" type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </header>
  )
}
