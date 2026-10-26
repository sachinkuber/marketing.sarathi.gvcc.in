import Link from 'next/link'
import type { OverdueAll } from './gating'

// The bar for signed-in screens that belong to no single brand (the front page, all brands, alerts): the
// stop button, one overdue bar per brand with something overdue, and sign out. Brand screens have their own.
export function AppBar(props: {
  userName: string
  overdue: OverdueAll | null
  stopHref: string | null
  onSignOut: () => void
}) {
  return (
    <>
      <header className="topbar">
        <div className="where">Marketing platform</div>
        <div className="sp" />
        {props.stopHref ? (
          <Link className="stopbtn" href={props.stopHref} title="Stop activity for a brand">
            Stop
          </Link>
        ) : null}
        <div className="userchip">
          <span className="avatar">{props.userName.slice(0, 1).toUpperCase()}</span>
          <span>{props.userName}</span>
        </div>
        <button className="btn sm" type="button" onClick={props.onSignOut}>
          Sign out
        </button>
      </header>
      {props.overdue && props.overdue.brands.length > 0 ? (
        <div className="banners">
          {props.overdue.brands.map((brand) => (
            <div className="banner warn" key={brand.brandId}>
              <b>
                {brand.count} {brand.count === 1 ? 'item' : 'items'} overdue for approval
              </b>
              <span>in {brand.brandName}</span>
              <Link href={`/b/${brand.brandId}/inbox?filter=overdue`}>Review overdue items</Link>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
