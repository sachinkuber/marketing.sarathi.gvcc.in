// PRD 16.1. Each row of the access table is a named permission; `label` is the row's exact text, and a
// test reads the PRD table to prove this file says what it says. The partner has no account (the access
// is a single-purpose link), so it is not an actor here.
export type Actor = 'platform_owner' | 'brand_admin' | 'approver' | 'sales_contact' | 'viewer'

export const ACTORS: readonly Actor[] = [
  'platform_owner',
  'brand_admin',
  'approver',
  'sales_contact',
  'viewer',
]

// 'own' is a narrower grant: a sales contact sees only their own leads. Routes that need it read the grant.
export type Grant = 'all' | 'own' | false

export const PERMISSION_KEYS = [
  'see_other_brands',
  'view_content',
  'edit_profile',
  'approve_content',
  'approve_budgets',
  'connect_accounts',
  'manage_users',
  'view_lead_data',
  'export_delete_data',
  'use_kill_switch',
] as const

export type PermissionKey = (typeof PERMISSION_KEYS)[number]

interface PermissionDefinition {
  label: string
  grants: Record<Actor, Grant>
}

const everyoneButSales = {
  platform_owner: 'all',
  brand_admin: 'all',
  approver: 'all',
  sales_contact: false,
} as const

export const PERMISSIONS: Record<PermissionKey, PermissionDefinition> = {
  see_other_brands: {
    label: 'See other brands',
    grants: {
      platform_owner: 'all',
      brand_admin: false,
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  view_content: {
    label: 'View brand content and reports',
    grants: { ...everyoneButSales, viewer: 'all' },
  },
  edit_profile: {
    label: 'Edit profile and verified facts',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  approve_content: {
    label: 'Approve content',
    grants: { ...everyoneButSales, viewer: false },
  },
  approve_budgets: {
    label: 'Approve budgets',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  connect_accounts: {
    label: 'Connect or disconnect accounts',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  manage_users: {
    label: 'Manage users',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  view_lead_data: {
    label: 'View lead personal data',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: 'own',
      viewer: false,
    },
  },
  export_delete_data: {
    label: 'Export or delete data',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
  use_kill_switch: {
    label: 'Use the kill switch',
    grants: {
      platform_owner: 'all',
      brand_admin: 'all',
      approver: false,
      sales_contact: false,
      viewer: false,
    },
  },
}

export function grantFor(actor: Actor, permission: PermissionKey): Grant {
  return PERMISSIONS[permission].grants[actor]
}
