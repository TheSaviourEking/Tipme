'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { loadBusinessRoles } from '@/lib/business/roles-api';

/**
 * Home's quiet "Add your business" link (PR B1): only while TipMe for businesses answers (the
 * roles read is 404 while BUSINESS_ENABLED is off) and the person manages none yet.
 */
export function AddBusinessLink() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    void loadBusinessRoles().then((roles) =>
      setShow(Boolean(roles && roles.manages.length === 0)),
    );
  }, []);
  if (!show) return null;
  return (
    <p className="add-business-link">
      <Link href="/dashboard/business/apply">Add your business</Link>
    </p>
  );
}
