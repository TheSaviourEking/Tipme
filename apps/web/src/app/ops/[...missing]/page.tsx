import { notFound } from 'next/navigation';

/** An admin address that doesn't exist: the admin's own missing page, inside the frame (ops/not-found). */
export default function MissingOpsPage() {
  notFound();
}
