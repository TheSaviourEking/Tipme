import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { signUpRecipient, tipAsVisitor } from '../e2e/helpers';
import { enrolOwner } from '../e2e/ops-helpers';
import { SCREENS, type ReviewContext } from './screens';

const OUT = 'review-screens';
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

for (const screen of SCREENS) {
  test(`${screen.group}: ${screen.name}`, async ({
    page,
    browser,
  }, testInfo) => {
    // A screen is only reviewable beside the board it is built to.
    expect(
      existsSync(`docs/design/redesign/boards/${screen.board}.dc.html`),
      `${screen.board} is not in docs/design/redesign/boards`,
    ).toBe(true);
    const ctx: ReviewContext = {
      recipient: () => signUpRecipient(page, testInfo),
      owner: () => enrolOwner(page, testInfo),
      recipientWithTips: async (count) => {
        const who = await signUpRecipient(page, testInfo);
        for (let tip = 0; tip < count; tip += 1)
          await tipAsVisitor(browser, who.handle);
        return who;
      },
    };
    await screen.open(page, ctx);
    // Parts of a page (the payment-mode wording, for one) stream in after the page has loaded. React
    // marks a part still waiting with a `$?` comment, or `$~` while it holds the reveal back for a
    // moment, so the picture waits until none is left.
    await page.waitForFunction(() => {
      const comments = document.createTreeWalker(
        document,
        NodeFilter.SHOW_COMMENT,
      );
      while (comments.nextNode())
        if (['$?', '$~'].includes(String(comments.currentNode.nodeValue)))
          return false;
      return true;
    });
    await page.evaluate(() => document.fonts.ready);
    const file = `${slug(screen.group)}/${slug(screen.name)}-${testInfo.project.name}.png`;
    mkdirSync(dirname(`${OUT}/${file}`), { recursive: true });
    await page.screenshot({
      path: `${OUT}/${file}`,
      // A screen with fixed bars is shot one phone screen tall, so they sit where they really do.
      fullPage:
        screen.fullPage ??
        !(screen.viewport && testInfo.project.name === 'phone'),
      animations: 'disabled',
      caret: 'hide',
    });
    appendFileSync(
      `${OUT}/shots.jsonl`,
      `${JSON.stringify({ group: screen.group, name: screen.name, board: screen.board, project: testInfo.project.name, file })}\n`,
    );
  });
}
