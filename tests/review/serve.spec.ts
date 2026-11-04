import { test } from '@playwright/test';
import { WEB_ORIGIN } from '../e2e/stack';

// `pnpm review:serve`: the same stack as the gallery, kept running so the owner can click through
// every screen. Stop it with Ctrl-C.
test('serve the review stack until stopped @serve', async () => {
  test.setTimeout(0);
  console.log(
    [
      '',
      `The redesign is running at ${WEB_ORIGIN}`,
      `  Home ${WEB_ORIGIN}/   A tip page ${WEB_ORIGIN}/@ada   Sign up ${WEB_ORIGIN}/sign-up`,
      `  Sign-in codes are at ${WEB_ORIGIN}/dev/inbox`,
      'Press Ctrl-C to stop.',
      '',
    ].join('\n'),
  );
  await new Promise(() => undefined);
});
