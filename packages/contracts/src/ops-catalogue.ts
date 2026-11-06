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
  'usernames.manage',
  'businesses.manage',
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
  // Sensitive: verifying makes a business's codes live; suspending stops its pages at once.
  'businesses.manage': {
    description: 'Verify, suspend and restore businesses, with a reason',
    group: 'people',
    sensitive: true,
  },
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
    description:
      'Pause and restore recipient pages, and review or remove their images',
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
  // Sensitive: taking a name from a page changes a person's account (PR 2's serious action needs it).
  'usernames.manage': {
    description:
      'Reserve and release usernames, and ask to take one back from a page',
    group: 'people',
    sensitive: true,
  },
};

/**
 * Routes under a sensitive permission that don't ask for a fresh code. Each is a read that shows no
 * private detail; the route test pins the verb and permission, and fails on anything else.
 */
export const OPS_FRESH_CODE_EXEMPT: Record<
  string,
  { verb: 'GET' | 'POST'; permission: OpsPermission; reason: string }
> = {
  // Stopping has to work first time in an incident. Permission, reason and audit still apply.
  'OpsWithdrawalsSwitchController.set': {
    verb: 'POST',
    permission: 'payouts.resolve',
    reason:
      'Switching off must work at once; the handler asks for a code to switch back on.',
  },
  'OpsPagesController.freeze': {
    verb: 'POST',
    permission: 'payouts.resolve',
    reason:
      'Stopping a takeover must work at once; releasing it goes through a fresh code.',
  },
  'OpsPagesController.freezeState': {
    verb: 'GET',
    permission: 'payouts.resolve',
    reason:
      'Says whether a page is frozen, so a freeze is never shown as absent; changes nothing.',
  },
  'OpsAccountRecoveryController.endSessions': {
    verb: 'POST',
    permission: 'recoveries.manage',
    reason:
      'Signing a stolen account out must work at once, and only stops access.',
  },
  'OpsWithdrawalsSwitchController.state': {
    verb: 'GET',
    permission: 'payouts.resolve',
    reason:
      'Says whether withdrawals are on, for whoever can stop them; changes nothing.',
  },
  'OpsAccessController.activity': {
    verb: 'GET',
    permission: 'audit.view',
    reason:
      'Fixed action names and masked staff addresses for the Overview; no reasons or private details.',
  },
  'OpsPagesController.pricing': {
    verb: 'GET',
    permission: 'fees.manage',
    reason: 'Shows a page’s fee numbers before a change; changes nothing.',
  },
  'OpsStaffController.roles': {
    verb: 'GET',
    permission: 'staff.manage',
    reason: 'Role names and permission lists: structure, no people’s details.',
  },
  'OpsStaffController.impact': {
    verb: 'POST',
    permission: 'staff.manage',
    reason:
      'A dry run of a role edit, a POST only to carry its body. Writes nothing.',
  },
  'OpsStaffController.access': {
    verb: 'GET',
    permission: 'staff.manage',
    reason:
      'One person’s role id and permission names: no email, phone or other detail.',
  },
};

/** Whoever holds one of these has a card on the Pages screen, so may find a page for it. */
export const OPS_PAGE_LOOKUP_PERMISSIONS: readonly OpsPermission[] = [
  'pages.plan',
  'pages.suspend',
  'fees.manage',
  'payouts.resolve',
  'recoveries.manage',
  'usernames.manage',
];

/**
 * Routes no one permission fits, where the operation authorises each person against each record.
 * Pinned, so a new one has to be argued for here.
 */
export const OPS_ANY_STAFF_ROUTES: Record<
  string,
  { verb: 'GET' | 'POST'; freshCode: boolean; reason: string }
> = {
  'OpsPagesController.page': {
    verb: 'GET',
    freshCode: false,
    reason:
      'Finds a page for whoever acts on pages (OPS_PAGE_LOOKUP_PERMISSIONS): public-level fields only.',
  },
  'OpsApprovalsController.list': {
    verb: 'GET',
    freshCode: false,
    reason: 'Filtered per person to permissions held and their own requests.',
  },
  'OpsApprovalsController.approve': {
    verb: 'POST',
    freshCode: false,
    reason:
      'Checks the request’s permission, and takes a code in the body for this approval.',
  },
  'OpsApprovalsController.reject': {
    verb: 'POST',
    freshCode: true,
    reason: 'Checks the permission the request names, per request.',
  },
  'OpsApprovalsController.cancel': {
    verb: 'POST',
    freshCode: false,
    reason: 'Only the person who asked, even if they have lost the permission.',
  },
};

/** Actions serious enough that a later task asks a second person to approve them. */
export const SERIOUS_ACTIONS = [
  'email_recovery.start',
  'payout.settle',
  'money_issue.close',
  'fee.change',
  'fee.free',
  'staff.grant_owner',
  'staff.grant_sensitive',
  'role.add_sensitive',
  'staff.reset_authenticator',
  'mail_provider.switch',
  'username.take_back',
] as const;
export type SeriousAction = (typeof SERIOUS_ACTIONS)[number];

/** Plain words for each action, on the screens and in staff emails. */
export const SERIOUS_ACTION_WORDS: Record<SeriousAction, string> = {
  'email_recovery.start': 'Move an account to a new email address',
  'payout.settle': 'Settle a stuck withdrawal',
  'money_issue.close': 'Close a money issue',
  'fee.change': 'Change a page’s fee',
  'fee.free': 'Give a page fee-free tips',
  'staff.grant_owner': 'Make someone an owner',
  'staff.grant_sensitive': 'Give someone sensitive access',
  'role.add_sensitive': 'Add sensitive access to a role',
  'staff.reset_authenticator': 'Reset someone’s authenticator',
  'mail_provider.switch': 'Switch the active email provider',
  'username.take_back': 'Take a username back from a page',
};

/** The permission each action needs, and so who can be the second person (spec 6.9). */
export const SERIOUS_ACTION_PERMISSIONS: Record<SeriousAction, OpsPermission> =
  {
    'email_recovery.start': 'recoveries.manage',
    'payout.settle': 'payouts.resolve',
    'money_issue.close': 'payouts.resolve',
    'fee.change': 'fees.manage',
    'fee.free': 'fees.manage',
    'staff.grant_owner': 'staff.manage',
    'staff.grant_sensitive': 'staff.manage',
    'role.add_sensitive': 'staff.manage',
    'staff.reset_authenticator': 'staff.manage',
    'mail_provider.switch': 'providers.manage',
    'username.take_back': 'usernames.manage',
  };
