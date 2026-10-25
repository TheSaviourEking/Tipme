import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { profiles, users } from './schema.js';

/**
 * Fictional demo recipients with test sign-in numbers (pretend messenger only). Their page
 * content used to live in the web app; it is data now. Safe to run repeatedly.
 */
export const DEMO_PROFILES = [
  {
    id: '00000000-0000-7000-8000-00000000ada0',
    userId: '00000000-0000-7000-8000-00000000a0a1',
    phone: '+2348000000001',
    handle: 'ada',
    displayName: 'Ada Okafor',
    role: 'Designer & generous internet person',
    bio: 'Making complicated things feel a little simpler. I share design notes, useful templates, and the occasional reminder to take a break.',
    note: 'If something I made helped you find your way, a little appreciation would make my day.',
    avatarPath: '/portraits/ada.webp',
    craft: 'Thoughtful design. Freely shared.',
  },
  {
    id: '00000000-0000-7000-8000-0000000070b1',
    userId: '00000000-0000-7000-8000-000000007b11',
    phone: '+2348000000002',
    handle: 'tobi',
    displayName: 'Tobi Adeyemi',
    role: 'Barista & brightener of mornings',
    bio: 'Good coffee, remembered names, and a little extra care. I believe the smallest details can change someone’s whole morning.',
    note: 'Thanks for letting me be a small part of your day. Your kind words already mean a lot.',
    avatarPath: '/portraits/tobi.webp',
    craft: 'A familiar face. A brighter morning.',
  },
] as const;

export async function seedDemoProfiles(db: Database): Promise<void> {
  await db
    .insert(users)
    .values(
      DEMO_PROFILES.map(({ userId, phone }) => ({
        id: userId,
        phoneE164: phone,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(profiles)
    .values(
      DEMO_PROFILES.map((demo) => ({
        id: demo.id,
        userId: demo.userId,
        handle: demo.handle,
        displayName: demo.displayName,
        role: demo.role,
        bio: demo.bio,
        note: demo.note,
        avatarPath: demo.avatarPath,
        craft: demo.craft,
        handleLower: demo.handle.toLowerCase(),
        visibility: 'public' as const,
        status: 'active' as const,
        pageState: 'live',
      })),
    )
    .onConflictDoUpdate({
      target: profiles.id,
      set: {
        userId: sql`excluded.user_id`,
        displayName: sql`excluded.display_name`,
        role: sql`excluded.role`,
        bio: sql`excluded.bio`,
        note: sql`excluded.note`,
        craft: sql`excluded.craft`,
        avatarPath: sql`excluded.avatar_path`,
      },
    });
}
