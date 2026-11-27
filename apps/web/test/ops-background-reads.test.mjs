import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Final review I1 (ruling L-R22): a read the staff stream starts (ready, resync, signal, the
// fallback poll) must send the background marker the scheduler hands it, or OpsGuard counts it as
// staff activity and an open, idle admin tab keeps its grant alive forever. So every staff
// screen's useLiveEvents callback takes that `read` and passes it on.
const webRoot = fileURLToPath(new URL('..', import.meta.url));
const roots = [
  join(webRoot, 'src/app/ops'),
  join(webRoot, 'src/components/ops'),
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function liveCalls(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useLiveEvents'
    )
      calls.push({ node, source });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** The callback's first parameter, used in its body (not just declared). */
function forwardsRead(callback) {
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
    return false;
  const first = callback.parameters[0];
  if (!first || !ts.isIdentifier(first.name)) return false;
  const name = first.name.text;
  let used = false;
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === name && node !== first.name)
      used = true;
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return used;
}

test("every staff screen's live reads pass the background marker on", () => {
  const calls = roots.flatMap(files).flatMap(liveCalls);
  // The menu's count, approvals, issues (twice), announcements and providers, at least.
  assert.ok(calls.length >= 6, `found ${calls.length}`);
  for (const { node, source } of calls) {
    const where = `${relative(webRoot, source.fileName)}:${
      source.getLineAndCharacterOfPosition(node.getStart()).line + 1
    }`;
    assert.ok(forwardsRead(node.arguments[1]), where);
  }
});
