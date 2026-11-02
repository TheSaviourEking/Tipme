'use client';
import Link from 'next/link';
import { Card } from '@tipme/ui';
import { OPS_CATALOGUE, type OpsPermission } from '@tipme/contracts';
import { can, useOpsAccess } from '@/lib/ops-client';

/** Everyone's own access; the people and roles behind it are for those who manage staff. */
export default function StaffPage() {
  const access = useOpsAccess();
  return (
    <section className="dashboard-section">
      <h1>Your access</h1>
      {can(access, 'staff.manage') && (
        <p>
          <Link href="/ops/staff/people">People</Link> ·{' '}
          <Link href="/ops/staff/roles">Roles</Link> ·{' '}
          <Link href="/ops/approvals">Approvals</Link>
        </p>
      )}
      <Card className="settings-section">
        <h2>Your role: {access.role === 'owner' ? 'Owner' : access.role}</h2>
        <ul className="ops-permissions">
          {access.permissions.map((permission) => (
            <li key={permission}>
              <code>{permission}</code>
              <span className="tm-hint">
                {OPS_CATALOGUE[permission as OpsPermission]?.description ?? ''}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
