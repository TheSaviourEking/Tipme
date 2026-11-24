import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewLoginPage } from '../src/lib/preview-login-page.ts';

test('the staging login page answers 200 with the logo as a data image', async () => {
  const response = await previewLoginPage({ next: '/@ada?x="1"' });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(
    html,
    /<img class="logo" src="data:image\/png;base64,[A-Za-z0-9+/=]+" width="131" height="36" alt="TipMe">/,
  );
  // The policy allows that data image and nothing else.
  assert.match(
    response.headers.get('content-security-policy') ?? '',
    /default-src 'none'; style-src 'unsafe-inline'; img-src data:;/,
  );
  // The return path is escaped.
  assert.match(html, /value="\/@ada\?x=&#34;1&#34;"/);
});

test('if the logo cannot be read the page still answers, with the name in text', async () => {
  const failing = () => Promise.reject(new Error('ENOENT'));
  const response = await previewLoginPage(
    { next: '/', error: 'That password is not right.', status: 401 },
    failing,
  );
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<p class="logo logo--text">TipMe<\/p>/);
  assert.match(html, /role="alert">That password is not right\.</);
  // A later read that works shows the image again (a failure is not kept).
  const ok = await (await previewLoginPage({ next: '/' })).text();
  assert.match(ok, /src="data:image\/png;base64,/);
});
