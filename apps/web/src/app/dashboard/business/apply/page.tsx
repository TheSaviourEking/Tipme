import type { Metadata } from 'next';
import { ApplyForm } from './apply-form';

export const metadata: Metadata = { title: 'Create your business' };

// The dashboard renders only after the signed-in profile loads in the browser (dashboard-shell).
export const instant = false;

export default function ApplyPage() {
  return <ApplyForm />;
}
