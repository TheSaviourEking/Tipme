import type { MyProfile, OpsTakeBack } from '@tipme/contracts';
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

export type UsernameFreeChange = NonNullable<MyProfile['usernameFreeChange']>;

/**
 * The dashboard notice after TipMe gave the page a username: it keeps the terms' promise to tell
 * people on their dashboard too, for anyone without an email address.
 */
export function freeChangeWords(f: UsernameFreeChange): {
  title: string;
  action: string;
} {
  return {
    title: `Your page has a new username, @${f.assignedHandle}. Links and QR codes with @${f.old} no longer work. You can change it once, for free, until ${lagosDateWords(new Date(f.until))}.`,
    action: 'Choose a new username',
  };
}

/** A take-back's state as staff read it: the meaning is in the words, never colour alone. */
export function takeBackStateWords(t: OpsTakeBack): string {
  switch (t.state) {
    case 'approved':
      return 'Notice being sent';
    case 'noticed':
      return t.dueAt
        ? `Notice sent, due ${lagosDateWords(new Date(t.dueAt))}`
        : 'Notice sent';
    case 'due':
      return 'Being completed';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
  }
}
