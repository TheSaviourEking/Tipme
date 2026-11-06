import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The states plan migrates `Notice` and `EmptyState` area by area. Each migrated file is listed
// here, so a later change can't bring the old tinted box back into it (Task 18 widens this to all
// of apps/web/src once every area is done).
const src = fileURLToPath(new URL('../src', import.meta.url));
const MIGRATED = [
  'components/appreciation-form.tsx',
  'components/report-page.tsx',
  'app/email/unsubscribed/unsubscribe-confirm.tsx',
  'app/mock-checkout/[reference]/mock-checkout-view.tsx',
  'app/tip/[tipId]/status-view.tsx',
  'app/design-system/page.tsx',
  'app/preview-states/page.tsx',
];
// `tm-empty` alone: `tm-empty-slip` and `tm-empty-well` are the new patterns.
const OLD = /\bNotice\b|\bEmptyState\b|tm-notice|tm-empty(?![-\w])/;

test('migrated files use the state patterns, not Notice or EmptyState', () => {
  const offenders = MIGRATED.filter((file) =>
    OLD.test(readFileSync(join(src, file), 'utf8')),
  );
  assert.deepEqual(offenders, []);
});

test('the guard sees the old patterns', () => {
  for (const text of [
    "import { Notice } from '@tipme/ui';",
    '<EmptyState title="x">',
    "querySelector('.tm-notice')",
    'className="tm-empty"',
  ])
    assert.match(text, OLD);
  // Words that only contain the names are fine (the pilot notice, an EmptySlip).
  for (const text of ['pilotNotice', '<EmptySlip />', 'tm-empty-slip'])
    assert.doesNotMatch(text, OLD);
});
