'use client';
import { Card } from '@tipme/ui';
import { useOpsAccess } from '@/lib/ops-client';

const DESCRIPTIONS: Record<string, string> = {
  'analytics.view': 'See health, visibility and market numbers',
  'audit.view': 'Read the audit log',
  'issues.resolve': 'Resolve issues',
  'issues.view': 'See issues and their evidence, add notes',
  'market.edit': 'Add and change market observations',
  'pages.suspend': 'Pause and restore recipient pages',
  'payments.recheck': 'Ask the provider about a payment or withdrawal',
  'private.view': 'Reveal private details, with a reason',
  'recoveries.cancel': 'Cancel a pending phone recovery',
};

/** Read-only for now: roles are granted with `pnpm ops:grant-owner` (ADR-0010). */
export default function StaffPage() {
  const access = useOpsAccess();
  return (
    <section className="dashboard-section">
      <h1>Staff &amp; roles</h1>
      <Card className="settings-section">
        <h2>Your role: {access.role === 'owner' ? 'Owner' : access.role}</h2>
        <ul className="ops-permissions">
          {access.permissions.map((permission) => (
            <li key={permission}>
              <code>{permission}</code>
              <span className="tm-hint">{DESCRIPTIONS[permission] ?? ''}</span>
            </li>
          ))}
        </ul>
        <p className="tm-hint">
          Staff are added only with <code>pnpm ops:grant-owner</code>. More
          roles (for example Support or Finance) are sets of these permissions
          and need no code change.
        </p>
      </Card>
    </section>
  );
}
