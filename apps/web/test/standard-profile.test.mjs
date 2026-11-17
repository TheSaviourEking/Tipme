import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The standard /@username page's markup as one component (spec 2026-11-17-page-studio-styles
// §9.1, §13): page.tsx and Classic's choices both render it. Pulling it out of page.tsx must not
// change one byte of today's page, so the component is rendered beside the markup page.tsx held
// before (copied here word for word, its parts swapped for marked stand-ins) and the two compared.
const out = new URL(
  '../node_modules/.cache/standard-profile-test/',
  import.meta.url,
);
mkdirSync(out, { recursive: true });
const transpile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

const componentSource = readFileSync(
  new URL('../src/components/profile/standard-profile.tsx', import.meta.url),
  'utf8',
);
writeFileSync(new URL('standard-profile.mjs', out), transpile(componentSource));
const { StandardProfile } = await import(new URL('standard-profile.mjs', out));

// page.tsx's return before the extraction (dev at 6282fc29), with each part a stand-in.
writeFileSync(
  new URL('before.mjs', out),
  transpile(`
const ProfileViewTracker = ({ handle }) => <i data-part="tracker">{handle}</i>;
const CoverView = () => <i data-part="cover" />;
const RecipientIdentity = (p) => <i data-part="identity">{p.firstName}{p.after}</i>;
const TipBlock = (p) => <i data-part="tip">{p.firstName}</i>;
const ProfileFoot = (p) => <i data-part="foot">{String(p.campaign)}</i>;
export function Before({ profile, firstName, campaignPage, after }) {
  const coverView = <CoverView />;
  return (
    <main id="main" tabIndex={-1} className="profile-page">
      <ProfileViewTracker handle={profile.handle} />
      <div className="profile-sheet">
        {coverView}
        <div className="profile-columns">
          <RecipientIdentity
            profile={profile}
            firstName={firstName}
            {...(campaignPage ? { after } : {})}
          />
          <aside
            className="profile-composer tip-instrument"
            aria-label={\`Tip \${firstName}\`}
            data-tip-panel
          >
            <TipBlock firstName={firstName} />
          </aside>
        </div>
        <ProfileFoot campaign={Boolean(campaignPage)} />
      </div>
    </main>
  );
}
export const parts = { ProfileViewTracker, CoverView, RecipientIdentity, TipBlock, ProfileFoot };
`),
);
const { Before, parts } = await import(new URL('before.mjs', out));

const render = (el) => renderToStaticMarkup(el);
const fixtures = [
  { profile: { handle: 'tobi' }, firstName: 'Tobi', campaignPage: null },
  {
    profile: { handle: 'kemi' },
    firstName: 'Kemi',
    campaignPage: { id: 'c' },
    after: createElement('b', null, 'campaign top'),
  },
  // A name that escapes: the label is React text either way.
  { profile: { handle: 'ade' }, firstName: 'Ade "&" <b>', campaignPage: null },
];

test('StandardProfile renders today’s markup byte for byte', () => {
  for (const f of fixtures) {
    const before = render(createElement(Before, f));
    const after = render(
      createElement(StandardProfile, {
        firstName: f.firstName,
        lead: createElement(parts.ProfileViewTracker, {
          handle: f.profile.handle,
        }),
        cover: createElement(parts.CoverView),
        identity: createElement(parts.RecipientIdentity, {
          profile: f.profile,
          firstName: f.firstName,
          ...(f.campaignPage ? { after: f.after } : {}),
        }),
        tipBlock: createElement(parts.TipBlock, { firstName: f.firstName }),
        footer: createElement(parts.ProfileFoot, {
          campaign: Boolean(f.campaignPage),
        }),
      }),
    );
    assert.equal(after, before, f.profile.handle);
  }
});

test('the public page renders the standard page through StandardProfile', () => {
  const page = readFileSync(
    new URL('../src/app/people/[handle]/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(page, /<StandardProfile\b/);
  assert.match(
    page,
    /import \{ StandardProfile \} from '@\/components\/profile\/standard-profile';/,
  );
  // The markup lives in one place only.
  assert.doesNotMatch(page, /className="profile-columns"/);
  assert.doesNotMatch(page, /className="profile-sheet"/);
});
