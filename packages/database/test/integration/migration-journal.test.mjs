import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// drizzle applies a migration only when its "when" is later than the newest one the database has
// seen, so a timestamp out of order is silently skipped on every database that is ahead of it.
const drizzle = new URL('../../drizzle/', import.meta.url);
const { entries } = JSON.parse(
  readFileSync(new URL('meta/_journal.json', drizzle), 'utf8'),
);

test('migration journal timestamps strictly increase', () => {
  for (let i = 1; i < entries.length; i++)
    assert.ok(
      entries[i].when > entries[i - 1].when,
      `${entries[i].tag} is not later than ${entries[i - 1].tag}`,
    );
});

test('the journal lists each migration once, in order, with its file', () => {
  // File numbers rise with the journal. A gap is allowed: a branch may take a number ahead of
  // migrations still to merge (animated covers is 0074 while 0071 to 0073 are other branches').
  let last = -1;
  entries.forEach((entry, i) => {
    assert.equal(entry.idx, i);
    const number = Number(/^(\d{4})_/.exec(entry.tag)?.[1]);
    assert.ok(number > last, entry.tag);
    assert.ok(number >= i, entry.tag);
    last = number;
    assert.ok(existsSync(new URL(`${entry.tag}.sql`, drizzle)), entry.tag);
  });
});

test('the handle rule migration is in the journal', () => {
  assert.ok(entries.some((entry) => entry.tag.endsWith('_handle_changes')));
});
