#!/usr/bin/env node
// Writes the generated parts of the pre-money documents (PR-014, PRD §15):
//   docs/security/access-control.md      the route and permission tables, from docs/api/openapi.json
//   docs/architecture/state-machines.md  the state diagrams, from the domain's own transition tables
//
//   pnpm docs:generate          rewrite them
//   pnpm docs:generate --check  fail when they are stale (scripts/generate-docs.test.mjs does too)
//
// Only the text between <!-- generated:NAME --> and <!-- /generated:NAME --> is ever replaced; the
// rest of each document is written by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ATTEMPT_TRANSITIONS,
  PAYOUT_TRANSITIONS,
  TIP_TRANSITIONS,
} from '../packages/domain/src/state-machines.ts';

const root = new URL('../', import.meta.url);

const ACCESS = [
  ['public', 'Anyone (no sign-in)'],
  ['status-token', 'Holder of the tip’s status token'],
  ['provider-signature', 'The payment provider (signed request body)'],
  ['release-token', 'The release check (bearer token; test copies only)'],
  ['recipient', 'Signed-in recipient (their own page and data only)'],
  ['staff', 'Signed-in staff, before an admin grant'],
  ['staff-grant', 'Staff with a live admin grant and the permission'],
];
const CHANGES = new Set(['post', 'put', 'patch', 'delete']);

/** Every operation in the API document, flattened. */
export function routesOf(openapi) {
  const routes = [];
  for (const [path, item] of Object.entries(openapi.paths))
    for (const [method, op] of Object.entries(item))
      routes.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        access: op['x-tipme-access'],
        permission: op['x-tipme-permission'] ?? null,
        csrf: op['x-tipme-csrf'] === true,
        rateLimit: op['x-tipme-rate-limit'] ?? null,
        pretendOnly: (op.tags ?? []).includes('pretend only'),
        changesState: CHANGES.has(method),
      });
  return routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

const yes = (value) => (value ? 'yes' : '–');
const code = (value) => (value ? `\`${value}\`` : '–');

function routeTables(routes) {
  const sections = [];
  for (const [access, label] of ACCESS) {
    const rows = routes.filter((r) => r.access === access);
    if (rows.length === 0) continue;
    const withPermission = access === 'staff-grant';
    sections.push(
      `#### ${label}`,
      '',
      `| Method | Path | ${withPermission ? 'Permission | ' : ''}Needs CSRF check | Rate limit | Pretend only |`,
      `| --- | --- | ${withPermission ? '--- | ' : ''}--- | --- | --- |`,
      ...rows.map(
        (r) =>
          `| ${r.method} | \`${r.path}\` | ${withPermission ? `${code(r.permission)} | ` : ''}${r.changesState ? yes(r.csrf) : 'n/a (read)'} | ${code(r.rateLimit)} | ${yes(r.pretendOnly)} |`,
      ),
      '',
    );
  }
  return sections.join('\n').trimEnd();
}

function permissionTable(routes) {
  const byPermission = new Map();
  for (const r of routes.filter((x) => x.permission)) {
    byPermission.set(r.permission, [
      ...(byPermission.get(r.permission) ?? []),
      `${r.method} \`${r.path}\``,
    ]);
  }
  return [
    '| Permission | Routes it unlocks |',
    '| --- | --- |',
    ...[...byPermission.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([permission, list]) => `| \`${permission}\` | ${list.join('<br>')} |`,
      ),
  ].join('\n');
}

function diagram(table) {
  const states = Object.keys(table);
  const lines = ['```mermaid', 'stateDiagram-v2', `  [*] --> ${states[0]}`];
  for (const [from, exits] of Object.entries(table)) {
    for (const to of exits) lines.push(`  ${from} --> ${to}`);
    if (exits.length === 0) lines.push(`  ${from} --> [*]`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** { file: { regionName: body } } for the current API document and state machines. */
export const DOC_REGIONS = (openapi) => {
  const routes = routesOf(openapi);
  return {
    'docs/security/access-control.md': {
      routes: routeTables(routes),
      permissions: permissionTable(routes),
    },
    'docs/architecture/state-machines.md': {
      tip: diagram(TIP_TRANSITIONS),
      attempt: diagram(ATTEMPT_TRANSITIONS),
      payout: diagram(PAYOUT_TRANSITIONS),
    },
  };
};

/** Replaces the body of each named generated region; throws when a marker is missing. */
export function applyRegions(text, regions) {
  let out = text;
  for (const [name, body] of Object.entries(regions)) {
    const start = `<!-- generated:${name} -->`;
    const end = `<!-- /generated:${name} -->`;
    const from = out.indexOf(start);
    const to = out.indexOf(end);
    if (from === -1 || to === -1 || to < from)
      throw new Error(`missing ${start} … ${end}`);
    out = `${out.slice(0, from + start.length)}\n\n${body}\n\n${out.slice(to)}`;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const openapi = JSON.parse(
    readFileSync(new URL('docs/api/openapi.json', root), 'utf8'),
  );
  let stale = false;
  for (const [file, regions] of Object.entries(DOC_REGIONS(openapi))) {
    const url = new URL(file, root);
    const before = readFileSync(url, 'utf8');
    const after = applyRegions(before, regions);
    if (after === before) continue;
    if (check) {
      console.error(`${file} is out of date: run pnpm docs:generate`);
      stale = true;
    } else {
      writeFileSync(url, after);
      console.log(`Wrote ${file}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('Generated documents are up to date.');
}
