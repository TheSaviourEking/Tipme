import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAIM_LINK_KEY,
  claimCodeFrom,
  claimLinkUrl,
  claimPreviewWords,
  clearClaimLink,
  takeClaimCode,
} from '../src/lib/claim-link.ts';

// A username claim link: `/sign-up/claim#claim=<code>` (handover, 18 Nov 2026). The code lives in
// the fragment, is taken out of the address bar at once, and is kept in this tab only.
function browser(hash = '', { storageBlocked = false } = {}) {
  const store = new Map();
  const replaced = [];
  globalThis.location = { hash, pathname: '/sign-up/claim', search: '' };
  globalThis.history = {
    replaceState: (_s, _t, url) => {
      replaced.push(url);
      globalThis.location.hash = '';
    },
  };
  globalThis.sessionStorage = {
    getItem: (k) => {
      if (storageBlocked) throw new Error('blocked');
      return store.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (storageBlocked) throw new Error('blocked');
      store.set(k, v);
    },
    removeItem: (k) => {
      if (storageBlocked) throw new Error('blocked');
      store.delete(k);
    },
  };
  return { store, replaced };
}

const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWX';

test('a claim fragment gives its code, upper-cased; anything else gives none', () => {
  assert.equal(claimCodeFrom(`#claim=${CODE}`), CODE);
  assert.equal(claimCodeFrom(`#claim=${CODE.toLowerCase()}`), CODE);
  for (const bad of [
    '',
    '#claim=',
    `#join=${CODE}`,
    `#claim=${CODE}A`,
    '#claim=ABC',
  ])
    assert.equal(claimCodeFrom(bad), null, bad);
});

test('taking the code moves it out of the address bar into this tab, and clearing forgets it', () => {
  const { store, replaced } = browser(`#claim=${CODE}`);
  assert.equal(takeClaimCode(), CODE);
  assert.deepEqual(replaced, ['/sign-up/claim']);
  assert.equal(location.hash, '');
  assert.equal(store.get(CLAIM_LINK_KEY), CODE);
  // A reload (or a sign-in in between) still has it.
  assert.equal(takeClaimCode(), CODE);
  clearClaimLink();
  assert.equal(takeClaimCode(), null);
});

test('with storage blocked, the code from the address bar still works once', () => {
  browser(`#claim=${CODE}`, { storageBlocked: true });
  assert.equal(takeClaimCode(), CODE);
  assert.equal(takeClaimCode(), null);
  clearClaimLink();
});

test('the link staff copy is the web origin plus the path the API gave', () => {
  assert.equal(
    claimLinkUrl('https://tipme.example', `/sign-up/claim#claim=${CODE}`),
    `https://tipme.example/sign-up/claim#claim=${CODE}`,
  );
});

test('each closed link says what happened, plainly, with no em dash', () => {
  const states = ['used', 'expired', 'cancelled', 'invalid'];
  const texts = states.map((state) => claimPreviewWords(state));
  assert.equal(new Set(texts.map((t) => t.title)).size, states.length);
  for (const { title, text } of texts) {
    assert.ok(title && text);
    assert.equal(/[–—]/.test(title + text), false);
    assert.equal(
      /bachs|licen[cs]e|regulat|approved by/i.test(title + text),
      false,
    );
  }
  assert.match(claimPreviewWords('expired').text, /14 days/);
});

test('a broken claim link in the address bar wins over one kept earlier: it says unknown', () => {
  const { store } = browser(`#claim=${CODE}`);
  assert.equal(takeClaimCode(), CODE);
  globalThis.location.hash = '#claim=NOTACODE';
  assert.equal(takeClaimCode(), null);
  assert.equal(location.hash, '');
  assert.equal(store.has(CLAIM_LINK_KEY), false);
});
