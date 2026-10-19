'use client';
import { useEffect } from 'react';
import { profileViewed } from '@/lib/analytics';

/** Counts one anonymous page view (nothing when the browser asks not to be tracked). */
export function ProfileViewTracker({ handle }: { handle: string }) {
  useEffect(() => profileViewed(handle), [handle]);
  return null;
}
