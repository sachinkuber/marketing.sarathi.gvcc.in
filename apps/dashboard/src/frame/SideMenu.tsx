import Link from 'next/link'

export type MenuRole = 'owner' | 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'

interface Entry {
  id: string
  label: string
  path: (brandId: string) => string
  roles: MenuRole[]
}

const ADMIN: MenuRole[] = ['owner', 'brand_admin']

// Phase 1 screens and who may reach them (app-flow 6). Items a role cannot use are not shown.
const MENU: Entry[] = [
  {
    id: 'home',
    label: 'Home',
    path: (b) => `/b/${b}`,
    roles: ['owner', 'brand_admin', 'approver', 'sales_contact', 'viewer'],
  },
  { id: 'inbox', label: 'Approval inbox', path: (b) => `/b/${b}/inbox`, roles: [...ADMIN, 'approver'] },
  { id: 'agents', label: 'Agents', path: (b) => `/b/${b}/agents`, roles: ADMIN },
  { id: 'alerts', label: 'Alerts and incidents', path: () => '/alerts', roles: ADMIN },
  { id: 'settings', label: 'Settings', path: (b) => `/b/${b}/settings`, roles: ADMIN },
]

export function menuFor(role: MenuRole): Entry[] {
  return MENU.filter((entry) => entry.roles.includes(role))
}

export function SideMenu(props: { brandId: string; role: MenuRole; current?: string }) {
  return (
    <nav className="rail" aria-label="Main">
      <div className="logo">Marketing platform</div>
      <div className="railnav">
        {menuFor(props.role).map((entry) => {
          const href = entry.path(props.brandId)
          const active = props.current === href
          return (
            <Link key={entry.id} href={href} aria-current={active ? 'page' : undefined}>
              <span>{entry.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
