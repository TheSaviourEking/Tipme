import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./trace-demo.mjs', import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('trace demo explains an unreachable API', () => {
  const result = run('--api', 'http://127.0.0.1:1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /API not reachable/);
});

test('trace demo explains disabled diagnostics', async (t) => {
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  // Asynchronous so this process can keep answering the script's request.
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [script, '--api', `http://127.0.0.1:${port}`],
      (error, _stdout, stderr) => resolve({ status: error?.code ?? 0, stderr }),
    ),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DIAGNOSTICS_ENABLED=true/);
});

test('trace demo rejects unknown modes', () => {
  const result = run('--mode', 'explode');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--mode must be one of/);
});
