import type { Page } from '@playwright/test';

/** What a screen needs before it can be shown: a signed-in recipient, with or without tips. */
export interface ReviewContext {
  recipient(): Promise<{ handle: string }>;
  recipientWithTips(count: number): Promise<{ handle: string }>;
}

/**
 * One screen in the owner's review gallery (docs/superpowers/plans/2026-11-03-screen-redesign.md).
 * `board` names the file in docs/design/redesign/boards it is built to, without `.dc.html`.
 */
export interface ReviewScreen {
  group: string;
  name: string;
  board: string;
  open(page: Page, ctx: ReviewContext): Promise<void>;
}

const visit = (path: string) => async (page: Page) => {
  await page.goto(path);
};

/** Each task of the redesign adds the screens it rebuilds, in the order of the plan. */
export const SCREENS: ReviewScreen[] = [
  { group: 'Public', name: 'Home', board: 'ScreenHome', open: visit('/') },
  {
    group: 'Tipping',
    name: 'Tip page',
    board: 'TipJourney',
    open: visit('/@ada'),
  },
];
