'use client';
import { Card } from '@tipme/ui';
import { OPS_CATALOGUE, type OpsPermission } from '@tipme/contracts';
import { useOpsAccess } from '@/lib/ops-client';

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
              <span className="tm-hint">
                {OPS_CATALOGUE[permission as OpsPermission]?.description ?? ''}
              </span>
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
