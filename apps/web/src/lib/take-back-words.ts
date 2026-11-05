import type { MyProfile } from '@tipme/contracts';
import { lagosDateWords } from '@tipme/domain';

export type UsernameTakeBack = NonNullable<MyProfile['usernameTakeBack']>;

/**
 * What the dashboard says while TipMe takes a username back (username reservation spec, 5.5). The
 * why is the category's fixed sentence from the server, shown under the title; never staff words.
 */
export function takeBackBannerWords(t: UsernameTakeBack): {
  title: string;
  why: string;
  action: string | null;
} {
  const date = lagosDateWords(new Date(t.dueAt));
  return t.kind === 'current'
    ? {
        title: `TipMe needs your username @${t.handle} back. Choose a new one by the end of ${date}.`,
        why: t.why,
        action: 'Choose a new username',
      }
    : {
        title: `Links that use your old username @${t.handle} will stop working after ${date}. Your username @${t.current} stays.`,
        why: t.why,
        action: null,
      };
}
