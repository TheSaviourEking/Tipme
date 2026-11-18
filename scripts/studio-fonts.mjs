#!/usr/bin/env node
/**
 * Page Studio's self-hosted font library (plan 2026-11-12-page-studio, Task 2).
 *
 *   node scripts/studio-fonts.mjs              prints each shipped file's size and sha256
 *   node scripts/studio-fonts.mjs build --python <python with fonttools + brotli>
 *                                               rebuilds every file from the pinned sources
 *
 * `build` downloads each family from google/fonts at SOURCE_COMMIT, refuses a file whose sha256
 * differs from the one recorded here, cuts it with fontTools, writes
 * `apps/web/public/fonts/studio/<id>-<weight>.woff2` and `OFL-<Family>.txt`, and prints the
 * metrics that `packages/contracts/src/studio-type.ts` records (copied there by hand, so a
 * rebuild that changes them shows up in review). Exact commands, as run for each family:
 *
 *   fonttools varLib.instancer <src> wght=<min:max | weight> <other axes>=drop -o <tmp>.ttf
 *   pyftsubset <tmp>.ttf --flavor=woff2 --no-hinting --layout-features=<FEATURES>
 *              --unicodes=<UNICODES> --output-file=<out>.woff2
 *
 * Page Studio styles (plan 2026-11-17-page-studio-styles, Task 1) add Unbounded, Anton, Source Serif 4
 * italic, Gentium Book Plus and a wider Inter cut (400 to 800, plus `tnum` and `lnum` so money sets
 * in tabular lining figures). Gentium Book Plus reserves the names "Gentium" and "SIL", so its three
 * files ship as a Modified Version renamed "Linen Serif" (OFL 1.1 §3; name IDs 1, 4, 6 and 16 are
 * rewritten and the copyright, trademark and unique-ID records, which carry those names, are
 * dropped; the licence file beside them keeps the original copyright and RFN lines, which is how
 * OFL 1.1 §2 asks for the notice).
 *
 * Not shipped: IBM Plex Sans, Lora, Playfair Display and Libre Baskerville. Their licences reserve
 * the family's own name, and OFL 1.1 §3 bars a Modified Version (a subset is one) from using it
 * without the authors' written permission.
 *
 * Unhinted, like the two interface fonts (hinting changes letter widths on Linux). The layout
 * features add `ccmp`, `locl`, `mark` and `mkmk` to the plan's `kern,liga,calt`, so tone marks sit
 * correctly on ẹ and ọ.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SOURCE_COMMIT = '29b4ec6df2522a8aee279414b78a07910b065874';
/** 2026-11-13T15:11:12Z, the source commit's date. */
export const SOURCE_DATE_EPOCH = 1794582672;
export const OUT_DIR = new URL(
  '../apps/web/public/fonts/studio/',
  import.meta.url,
);

export const UNICODES =
  'U+0000-024F,U+0253,U+0257,U+02BC,U+02C6-02DD,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+20A6,U+20AC,U+2122,U+2212';
export const FEATURES = 'kern,liga,calt,ccmp,locl,mark,mkmk';
/** Money is Inter with tabular, lining figures. */
const INTER_FEATURES = `${FEATURES},tnum,lnum`;

/**
 * One entry per shipped file (`id` is the registry family, so a family can have several). A family that can set body text keeps its `wght` axis from its text weight
 * to its heading weight; a heading-only family is pinned to its heading weight. Other axes are
 * pinned at their defaults. `sha256` is the upstream file's.
 */
export const SOURCES = [
  {
    id: 'manrope',
    family: 'Manrope',
    dir: 'manrope',
    file: 'Manrope[wght].ttf',
    weight: '700',
    sha256: '3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6',
  },
  {
    id: 'dm-serif-display',
    family: 'DMSerifDisplay',
    dir: 'dmserifdisplay',
    file: 'DMSerifDisplay-Regular.ttf',
    weight: '400',
    static: true,
    sha256: '8cc3643535edf039aa5d95440a8542735e9197e4f4b8d9303e980fefbf5ab616',
  },
  {
    id: 'inter',
    family: 'Inter',
    dir: 'inter',
    file: 'Inter[opsz,wght].ttf',
    weight: '400 800',
    features: INTER_FEATURES,
    sha256: '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031',
  },
  {
    id: 'work-sans',
    family: 'WorkSans',
    dir: 'worksans',
    file: 'WorkSans[wght].ttf',
    weight: '400 600',
    sha256: 'f50f61f2ba738e239442d40bf1069adb195c224b6a5a73a581fc2f3ed62a9f63',
  },
  {
    id: 'space-grotesk',
    family: 'SpaceGrotesk',
    dir: 'spacegrotesk',
    file: 'SpaceGrotesk[wght].ttf',
    weight: '600',
    sha256: 'acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72',
  },
  {
    id: 'bricolage-grotesque',
    family: 'BricolageGrotesque',
    dir: 'bricolagegrotesque',
    file: 'BricolageGrotesque[opsz,wdth,wght].ttf',
    weight: '700',
    sha256: '413e7357809ddd12fd80a96a8a396de0e401638d4acd3cb3e37532f0472ac682',
  },
  {
    id: 'outfit',
    family: 'Outfit',
    dir: 'outfit',
    file: 'Outfit[wght].ttf',
    weight: '600',
    sha256: 'fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade',
  },
  {
    id: 'nunito',
    family: 'Nunito',
    dir: 'nunito',
    file: 'Nunito[wght].ttf',
    weight: '400 700',
    sha256: 'bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207',
  },
  {
    id: 'fraunces',
    family: 'Fraunces',
    dir: 'fraunces',
    file: 'Fraunces[SOFT,WONK,opsz,wght].ttf',
    weight: '600',
    sha256: '177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb',
  },
  {
    id: 'source-serif-4',
    family: 'SourceSerif4',
    dir: 'sourceserif4',
    file: 'SourceSerif4[opsz,wght].ttf',
    weight: '400 600',
    sha256: '97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b',
  },
  {
    id: 'source-serif-4',
    family: 'SourceSerif4',
    dir: 'sourceserif4',
    file: 'SourceSerif4-Italic[opsz,wght].ttf',
    weight: '400',
    style: 'italic',
    sha256: '15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42',
  },
  {
    id: 'unbounded',
    family: 'Unbounded',
    dir: 'unbounded',
    file: 'Unbounded[wght].ttf',
    weight: '600 700',
    sha256: '323b511be380c8d474ef030686b71aedde501f8d9cd46da558b7c40454372c3f',
  },
  {
    id: 'anton',
    family: 'Anton',
    dir: 'anton',
    file: 'Anton-Regular.ttf',
    weight: '400',
    static: true,
    sha256: 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab',
  },
  ...[
    [
      'Regular',
      '400',
      'normal',
      'fe7b64eeacc430fcf46836a6f0dfe00d2c5a15483ed36692a2a185cb23ec2a5c',
    ],
    [
      'Bold',
      '700',
      'normal',
      'b39c3fb12e2e15e2336f2ec6d051c778618ec25f7360bc4765bfe755b408c011',
    ],
    [
      'Italic',
      '400',
      'italic',
      '7a0ab4bd78701fa46d325e362654c41a47e2a0a5cb4a3eebc94dce89c2ee7df1',
    ],
  ].map(([face, weight, style, sha256]) => ({
    id: 'linen-serif',
    family: 'GentiumBookPlus',
    dir: 'gentiumbookplus',
    file: `GentiumBookPlus-${face}.ttf`,
    weight,
    style,
    static: true,
    rename: { family: 'Linen Serif', face },
    sha256,
  })),
];

export const outputName = (s) =>
  `${s.id}-${s.weight.replace(' ', '-')}${s.style === 'italic' ? '-italic' : ''}.woff2`;
export const licenceName = (s) => `OFL-${s.family}.txt`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Metrics measured with fontTools, in font units. avgAdvance: mean advance of a–z and space.
// maxWordAdvance: the widest letter (A–Z, a–z, and the Yoruba and Igbo capitals), the per-letter
// upper bound the design check uses for a word's width. Arial and Georgia are measured the same
// way, from the copies macOS ships, for the metric-matched fallbacks.
const METRICS_PY = String.raw`
import json, sys
from fontTools.ttLib import TTFont
out = {}
for path in sys.argv[1:]:
    f = TTFont(path)
    cmap = f.getBestCmap(); hmtx = f['hmtx']
    adv = lambda ch: hmtx[cmap[ord(ch)]][0]
    lower = [adv(c) for c in 'abcdefghijklmnopqrstuvwxyz ']
    letters = [c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzẸỌṢỊỤṄ' if ord(c) in cmap]
    out[path] = dict(
        unitsPerEm=f['head'].unitsPerEm, ascent=f['hhea'].ascent, descent=f['hhea'].descent,
        lineGap=f['hhea'].lineGap, xHeight=getattr(f['OS/2'], 'sxHeight', 0),
        avgAdvance=round(sum(lower) / len(lower)), maxWordAdvance=max(adv(c) for c in letters))
print(json.dumps(out))
`;

// Modified Version rename (OFL 1.1 §3): sets name IDs 1, 4, 6 (and 16 where a family has it) to the
// new family and drops the copyright (0) and unique ID (3) records, which carry the Reserved Font
// Names. Subsetting then keeps only IDs 0 to 6, so no other record survives.
const RENAME_PY = String.raw`
import sys
from fontTools.ttLib import TTFont
path, out, family, face = sys.argv[1:5]
f = TTFont(path)
name = f['name']
full = family if face == 'Regular' else family + ' ' + face
for rec in list(name.names):
    if rec.nameID in (0, 3, 7, 8, 9, 10, 11, 12, 13, 14) or rec.nameID >= 256:
        name.removeNames(nameID=rec.nameID)
for platform, enc, lang in ((3, 1, 0x409), (1, 0, 0)):
    name.setName(family, 1, platform, enc, lang)
    name.setName(face, 2, platform, enc, lang)
    name.setName(full, 4, platform, enc, lang)
    name.setName(family.replace(' ', '') + '-' + face, 6, platform, enc, lang)
    if name.getName(16, platform, enc, lang):
        name.setName(family, 16, platform, enc, lang)
f.save(out)
`;

function build(python) {
  const work = mkdtempSync(join(tmpdir(), 'studio-fonts-'));
  mkdirSync(OUT_DIR, { recursive: true });
  const run = (args) =>
    execFileSync(python, ['-I', ...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
      // fontTools stamps head.modified from this, so a rebuild is byte-for-byte the same.
      env: { ...process.env, SOURCE_DATE_EPOCH: String(SOURCE_DATE_EPOCH) },
    });
  return (async () => {
    const outputs = [];
    const licences = new Set();
    for (const s of SOURCES) {
      const base = `https://raw.githubusercontent.com/google/fonts/${SOURCE_COMMIT}/ofl/${s.dir}/`;
      const response = await fetch(base + encodeURIComponent(s.file));
      if (!response.ok) throw new Error(`${s.id}: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== s.sha256)
        throw new Error(`${s.id}: upstream sha256 changed`);
      const source = join(work, outputName(s).replace('.woff2', '.ttf'));
      writeFileSync(source, bytes);
      let cut = source;
      if (!s.static) {
        const axes = /\[(.+)\]/.exec(s.file)[1].split(',');
        const pins = axes.map((a) =>
          a === 'wght' ? `wght=${s.weight.replace(' ', ':')}` : `${a}=drop`,
        );
        cut = join(work, outputName(s).replace('.woff2', '-instance.ttf'));
        run([
          '-m',
          'fontTools.varLib.instancer',
          source,
          ...pins,
          '-q',
          '-o',
          cut,
        ]);
      }
      if (s.rename) {
        const renamed = join(
          work,
          outputName(s).replace('.woff2', '-renamed.ttf'),
        );
        run(['-c', RENAME_PY, cut, renamed, s.rename.family, s.rename.face]);
        cut = renamed;
      }
      const out = new URL(outputName(s), OUT_DIR).pathname;
      run([
        '-m',
        'fontTools.subset',
        cut,
        '--flavor=woff2',
        '--no-hinting',
        `--layout-features=${s.features ?? FEATURES}`,
        `--unicodes=${UNICODES}`,
        `--output-file=${out}`,
      ]);
      if (!licences.has(licenceName(s))) {
        licences.add(licenceName(s));
        const licence = await fetch(`${base}OFL.txt`);
        writeFileSync(
          new URL(licenceName(s), OUT_DIR),
          Buffer.from(await licence.arrayBuffer()),
        );
      }
      outputs.push([outputName(s), out]);
    }
    const fallbacks = [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Georgia.ttf',
    ];
    const metrics = JSON.parse(
      run([
        '-c',
        METRICS_PY,
        ...outputs.map(([, p]) => p),
        ...fallbacks,
      ]).toString(),
    );
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(metrics).map(([p, m]) => [
            outputs.find(([, o]) => o === p)?.[0] ?? p,
            m,
          ]),
        ),
        null,
        1,
      ),
    );
  })();
}

function report() {
  for (const name of readdirSync(OUT_DIR)
    .filter((n) => n.endsWith('.woff2'))
    .sort()) {
    const bytes = readFileSync(new URL(name, OUT_DIR));
    console.log(`${name}\t${bytes.length}\t${sha256(bytes)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'build') {
    const at = process.argv.indexOf('--python');
    if (at < 0)
      throw new Error(
        'build needs --python <python with fonttools and brotli>',
      );
    await build(process.argv[at + 1]);
  } else report();
}
