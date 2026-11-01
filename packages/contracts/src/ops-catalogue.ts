/**
 * The one catalogue of admin permissions and serious actions. The database check
 * constraint, the API guards, the staff screens and (later) role editing all read it,
 * so a permission is described, grouped and marked sensitive in exactly one place.
 */
export const OPS_PERMISSIONS = [
  'issues.view',
  'issues.resolve',
  'pages.suspend',
  'recoveries.cancel',
  'analytics.view',
  'market.edit',
  'audit.view',
  'payments.recheck',
  'private.view',
  'pages.plan',
  'search.view',
  'fees.manage',
  'providers.manage',
  'recoveries.manage',
  'payouts.resolve',
  'email.read',
  'email.export',
  'payments.repair',
  'staff.manage',
] as const;
export type OpsPermission = (typeof OPS_PERMISSIONS)[number];

export const OPS_PERMISSION_GROUPS = [
  'money',
  'people',
  'content',
  'numbers',
  'settings',
] as const;
export type OpsPermissionGroup = (typeof OPS_PERMISSION_GROUPS)[number];

export interface OpsCatalogueEntry {
  description: string;
  group: OpsPermissionGroup;
  /** Money movement, private data, or control of who can do what. */
  sensitive: boolean;
}

export const OPS_CATALOGUE: Record<OpsPermission, OpsCatalogueEntry> = {
  'analytics.view': {
    description: 'See health, visibility and market numbers',
    group: 'numbers',
    sensitive: false,
  },
  'audit.view': {
    description: 'Read the audit log',
    group: 'numbers',
    sensitive: true,
  },
  'email.export': {
    description: 'Download the email log as a spreadsheet',
    group: 'content',
    sensitive: true,
  },
  'email.read': {
    description: 'Open a sent email: its delivery timeline and its content',
    group: 'content',
    sensitive: true,
  },
  'fees.manage': {
    description: 'Set a page’s fee and grant fee-free tips, with a reason',
    group: 'money',
    sensitive: true,
  },
  'issues.resolve': {
    description: 'Resolve issues',
    group: 'content',
    sensitive: false,
  },
  'issues.view': {
    description: 'See issues and their evidence, add notes',
    group: 'content',
    sensitive: false,
  },
  'market.edit': {
    description: 'Add and change market observations',
    group: 'numbers',
    sensitive: false,
  },
  'pages.plan': {
    description: 'Move a page between Free and Pro, with a reason',
    group: 'money',
    sensitive: true,
  },
  'pages.suspend': {
    description: 'Pause and restore recipient pages',
    group: 'people',
    sensitive: false,
  },
  'payments.recheck': {
    description: 'Ask the provider about a payment or withdrawal',
    group: 'money',
    sensitive: false,
  },
  'payments.repair': {
    description:
      'Repair a payment record from the provider dashboard: link a checkout, confirm who bears the fee, recover an account',
    group: 'money',
    sensitive: true,
  },
  'payouts.resolve': {
    description:
      'Act on a stuck withdrawal after asking the provider: record its answer, resume a held start, or release one it doesn’t have',
    group: 'money',
    sensitive: true,
  },
  'private.view': {
    description: 'Reveal private details, with a reason',
    group: 'people',
    sensitive: true,
  },
  'providers.manage': {
    description: 'Change payment and email provider settings',
    group: 'settings',
    sensitive: true,
  },
  'recoveries.cancel': {
    description: 'Cancel a pending phone recovery',
    group: 'people',
    sensitive: false,
  },
  'recoveries.manage': {
    description: 'Start and manage account recoveries for a person',
    group: 'people',
    sensitive: true,
  },
  'search.view': {
    description: 'Search pages, tips, withdrawals and ledger entries',
    group: 'content',
    sensitive: false,
  },
  'staff.manage': {
    description: 'Add staff, change their access and roles',
    group: 'settings',
    sensitive: true,
  },
};

/** Actions serious enough that a later task asks a second person to approve them. */
export const SERIOUS_ACTIONS = [
  'email_recovery.start',
  'payout.settle',
  'balance.write_off',
  'fee.change',
  'fee.free',
  'staff.grant_owner',
  'staff.grant_sensitive',
  'role.add_sensitive',
  'staff.reset_authenticator',
  'mail_provider.switch',
] as const;
export type SeriousAction = (typeof SERIOUS_ACTIONS)[number];
