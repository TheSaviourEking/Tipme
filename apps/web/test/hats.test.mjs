import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentHat, hatHref, hatLabel, hatsOf } from '../src/lib/hats.ts';

// Business sign-up, Task D6: the hats on one login, from the board's three people.
const account = (handle) => ({
  userId: 'u',
  email: 'x@example.com',
  emailVerified: true,
  hasProfile: handle !== null,
  handle,
});
const manages = (businessId, name, status, role = 'owner', extra = {}) => ({
  businessId,
  slug: businessId,
  name,
  status,
  role,
  ...extra,
});

test('Tunde: his page, two businesses he owns, and where he works, in that order', () => {
  const hats = hatsOf(account('tunde_grills'), {
    manages: [
      manages('k', 'Kilishi Corner', 'pending'),
      manages('s', 'Tunde’s Suya Spot', 'verified', 'owner', {
        plan: 'pro',
        logoPath: '/v1/business-logos/s/2.webp',
      }),
    ],
    works: [
      {
        memberId: 'm1',
        businessName: 'Mama Put Lekki',
        locationName: 'Admiralty Way',
        logoPath: '/v1/business-logos/mp/1.webp',
      },
    ],
    invitations: 0,
  });
  assert.deepEqual(hats, [
    { kind: 'page', handle: 'tunde_grills' },
    {
      kind: 'owner',
      businessId: 'k',
      name: 'Kilishi Corner',
      status: 'pending',
      logoPath: null,
    },
    {
      kind: 'owner',
      businessId: 's',
      name: 'Tunde’s Suya Spot',
      status: 'verified',
      plan: 'pro',
      logoPath: '/v1/business-logos/s/2.webp',
    },
    {
      kind: 'work',
      memberId: 'm1',
      businessName: 'Mama Put Lekki',
      locationName: 'Admiralty Way',
      logoPath: '/v1/business-logos/mp/1.webp',
    },
  ]);
  assert.deepEqual(hats.map(hatHref), [
    '/dashboard',
    '/dashboard/business?business=k',
    '/dashboard/business?business=s',
    '/dashboard/work',
  ]);
});

test('Ngozi: business only, no page hat', () => {
  const hats = hatsOf(account(null), {
    manages: [manages('mp', 'Mama Put Lekki', 'verified')],
    works: [],
    invitations: 0,
  });
  assert.deepEqual(hats, [
    {
      kind: 'owner',
      businessId: 'mp',
      name: 'Mama Put Lekki',
      status: 'verified',
      logoPath: null,
    },
  ]);
});

test('Ada: her page only; with businesses off (no roles) the same', () => {
  const ada = [{ kind: 'page', handle: 'ada' }];
  assert.deepEqual(
    hatsOf(account('ada'), { manages: [], works: [], invitations: 0 }),
    ada,
  );
  assert.deepEqual(hatsOf(account('ada'), null), ada);
});

test('owners come before location managers, and several jobs are one Work hat', () => {
  const hats = hatsOf(account('chidi'), {
    manages: [
      manages('a', 'Alpha', 'verified', 'location_manager', {
        locationId: 'l',
      }),
      manages('b', 'Beta', 'verified'),
    ],
    works: [
      { memberId: 'w1', businessName: 'One', locationName: 'X' },
      { memberId: 'w2', businessName: 'Two', locationName: 'Y' },
    ],
    invitations: 0,
  });
  assert.deepEqual(
    hats.map((hat) => hat.kind),
    ['page', 'owner', 'manager', 'work', 'work'],
  );
});

test('the hat being worn follows the address', () => {
  const hats = hatsOf(account('tunde_grills'), {
    manages: [
      manages('s', 'Suya', 'verified'),
      manages('k', 'Kilishi', 'pending'),
    ],
    works: [{ memberId: 'm1', businessName: 'Mama Put', locationName: 'A' }],
    invitations: 0,
  });
  assert.equal(currentHat(hats, '/dashboard/tips', '')?.kind, 'page');
  assert.equal(
    currentHat(hats, '/dashboard/business', '?business=k')?.businessId,
    'k',
  );
  // No business in the address: the first one, as the Business page opens it.
  assert.equal(currentHat(hats, '/dashboard/business', '')?.businessId, 's');
  assert.equal(currentHat(hats, '/dashboard/work', '')?.kind, 'work');
  // Settings belongs to the login: no hat from the address.
  assert.equal(currentHat(hats, '/dashboard/settings', ''), null);
});

test('the page goes by its username, with the name standing in only without one', () => {
  assert.equal(
    hatLabel({ kind: 'page', handle: 'tunde_grills' }, 'Tunde'),
    '@tunde_grills',
  );
  assert.equal(hatLabel({ kind: 'page', handle: '' }, 'Tunde'), 'Tunde');
  assert.equal(hatLabel({ kind: 'page', handle: '' }, null), 'Your page');
  assert.equal(
    hatLabel({
      kind: 'work',
      memberId: 'm',
      businessName: 'Mama Put',
      locationName: 'A',
      logoPath: null,
    }),
    'Mama Put',
  );
});
