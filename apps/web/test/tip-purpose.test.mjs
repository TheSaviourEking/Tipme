import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { tipPurposes } from '@tipme/contracts';
import { purposeOptions } from '../src/lib/tip-purpose.ts';

test('the tip form offers exactly the contract purposes, in order', () => {
  assert.deepEqual(
    purposeOptions.map((option) => option.value),
    [...tipPurposes],
  );
  for (const option of purposeOptions) assert.ok(option.label.length > 0);
});

test('the module stays free of runtime contracts imports (they ship zod to the browser)', () => {
  const source = readFileSync(
    new URL('../src/lib/tip-purpose.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /import\s+\{(?!\s*type\b)[^}]*\}\s+from\s+'@tipme\/contracts'/,
  );
});
