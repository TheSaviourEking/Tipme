import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAIL_TYPES } from '../dist/index.js';

const script = fileURLToPath(
  new URL('../scripts/preview.mjs', import.meta.url),
);

test('the preview writes one html and one text file per type', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-preview-'));
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, MAIL_PREVIEW_DIR: dir },
      stdio: 'pipe',
    });
    const files = readdirSync(dir);
    const ids = Object.keys(MAIL_TYPES);
    for (const id of ids) {
      assert.ok(files.includes(`${id}.html`), `${id}.html`);
      assert.ok(files.includes(`${id}.txt`), `${id}.txt`);
    }
    assert.equal(
      files.filter((f) => f.endsWith('.html')).length,
      ids.length + 1,
    );
    assert.equal(files.filter((f) => f.endsWith('.txt')).length, ids.length);
    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    for (const id of ids)
      assert.ok(index.includes(`${id}.html`), `index links ${id}`);
    // Both of the boards' widths.
    assert.match(index, /width="720"/);
    assert.match(index, /width="390"/);
    // Types with a switch show their settings link.
    assert.match(
      readFileSync(join(dir, 'tip_received.txt'), 'utf8'),
      /Email settings: https:\/\/usetipme\.xyz\//,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
