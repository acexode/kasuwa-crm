#!/usr/bin/env node
/**
 * Downloads the self-hosted webfonts and emits `src/fonts.generated.css`.
 *
 * WHY SELF-HOST
 *
 * Kasuwa's users are on Nigerian, Ghanaian and Kenyan mobile networks, and the
 * NFRs commit to a workspace usable at 256 kbps (PRD 2.13). A third-party font
 * host is an extra DNS lookup, an extra TLS handshake and an extra origin that
 * can be slow or blocked — on the connections that matter most, that is the
 * difference between text appearing and a blank screen. It is also a
 * third-party request carrying the user's IP on every page load, which is an
 * NDPA question we do not need to have.
 *
 * SELF-HOSTED ONLY (D-L43). Every `src` names a file under `/fonts/` and
 * nothing else. There used to be a `fonts.gstatic.com` fallback second in each
 * list, and it quietly undid the paragraph above: a self-hosted file that
 * failed sent the browser to Google, which is a third origin on a 256 kbps
 * link and the user's IP handed to a third party. If a local file 404s after a
 * bad deploy, the text renders in the fallback stack and the deploy is fixed;
 * that is the right failure. `src/fonts.test.ts` greps the generated CSS for
 * any external origin.
 *
 * CURRENCY SIGNS (D-L44)
 *
 * The naira (U+20A6) and cedi (U+20B5) fall inside Noto Sans Latin-Extended,
 * a 168 KB file. One `₦` on a screen used to download all of it, which put
 * `/onboarding` over the 300 KB ceiling by itself. So the currency signs get a
 * subset of their own — a few KB, requested with Google's `text=` parameter —
 * listed AHEAD of Latin-Extended, and they are cut out of Latin-Extended's
 * `unicode-range` so no large face claims them. A face is downloaded only when
 * the page uses a code point in its range, so a naira amount now costs the
 * small file and Yorùbá, Igbo and Hausa diacritics still get the large one.
 *
 * ICON SUBSETTING
 *
 * Material Symbols Rounded is several megabytes whole. Only the glyphs the
 * design actually uses are requested, by name, which is the difference between
 * a ~10 KB file and an unusable one.
 *
 * Licences: Noto Sans, Noto Sans Arabic and JetBrains Mono are SIL OFL 1.1;
 * Material Symbols is Apache 2.0. All are redistributable — see
 * apps/web/public/fonts/LICENSES.md.
 *
 * Run: pnpm ui:fetch-fonts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..', '..');
const fontDir = resolve(root, 'apps/web/public/fonts');
const cssOut = resolve(root, 'packages/ui/src/fonts.generated.css');
const iconListPath = resolve(root, 'packages/ui/icon-subset.txt');
const iconTypesOut = resolve(root, 'packages/ui/src/icons.generated.ts');

// A browser user agent is required, or Google Fonts serves TTF instead of the
// far smaller woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Subsets shipped per family. Cyrillic, Greek, Devanagari and Vietnamese are
 * not needed. Noto Sans Arabic ships ONLY the arabic subset — Noto Sans already
 * covers Latin, and shipping it twice would be ~30 KB of duplicate glyphs on a
 * 256 kbps connection.
 */
const DEFAULT_SUBSETS = ['latin', 'latin-ext'];

const FAMILIES = [
  {
    id: 'noto-sans',
    css: 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400..800&display=swap',
    family: 'Noto Sans',
    subsets: DEFAULT_SUBSETS,
    note: 'Latin Extended A/B + Additional — Yoruba, Igbo, Hausa diacritics',
    // D-L44: a small face for the currency signs, carved out of latin-ext.
    currency: true,
  },
  {
    id: 'noto-sans-arabic',
    css: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400..700&display=swap',
    family: 'Noto Sans Arabic',
    subsets: ['arabic'],
    note: 'RTL fallback — arabic subset only, Noto Sans covers Latin',
  },
  {
    id: 'jetbrains-mono',
    css: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..600&display=swap',
    family: 'JetBrains Mono',
    subsets: DEFAULT_SUBSETS,
    note: 'ids, E.164 phone numbers, money — tabular figures',
  },
];

/** ₦ (naira) and ₵ (cedi): the signs D-L44 found pulling in Latin-Extended. */
const CURRENCY_CODE_POINTS = [0x20a6, 0x20b5];

/**
 * A currency subset is a handful of glyphs. Anything near the size of the file
 * it replaces means `text=` stopped subsetting, and shipping it would put the
 * 168 KB back on every screen with a naira amount.
 */
const CURRENCY_SUBSET_MAX_BYTES = 20 * 1024;

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

async function fetchBinary(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Splits a Google Fonts css2 response into its @font-face blocks. */
function parseFaces(css) {
  const faces = [];
  const blockPattern = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let match;
  while ((match = blockPattern.exec(css)) !== null) {
    const [, subset, body] = match;
    // Note: subset URLs for Material Symbols are /l/font?kit=... with no file
    // extension, so match on the format() declaration rather than on ".woff2".
    const url = /url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/.exec(body)?.[1];
    if (url === undefined) continue;
    faces.push({
      subset: subset ?? 'unknown',
      url,
      style: /font-style:\s*([^;]+);/.exec(body)?.[1].trim() ?? 'normal',
      weight: /font-weight:\s*([^;]+);/.exec(body)?.[1].trim() ?? '400',
      unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1].trim() ?? '',
    });
  }
  return faces;
}

/** `U+0100-02BA, U+20AD` -> [[0x100, 0x2ba], [0x20ad, 0x20ad]]. */
function parseRange(value) {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^U\+/i, ''))
    .filter((part) => part !== '')
    .map((part) => {
      const [start, end] = part.split('-');
      const low = parseInt(start, 16);
      return [low, end === undefined ? low : parseInt(end, 16)];
    });
}

function hex(codePoint) {
  return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

function formatRange(ranges) {
  return ranges
    .map(([start, end]) => (start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`))
    .join(', ');
}

/**
 * Removes `codePoints` from a `unicode-range`, splitting any span that holds
 * one. `U+20A0-20AB` minus U+20A6 is `U+20A0-20A5, U+20A7-20AB`.
 */
function withoutCodePoints(unicodeRange, codePoints) {
  let ranges = parseRange(unicodeRange);
  for (const point of codePoints) {
    ranges = ranges.flatMap(([start, end]) => {
      if (point < start || point > end) return [[start, end]];
      const pieces = [];
      if (start < point) pieces.push([start, point - 1]);
      if (point < end) pieces.push([point + 1, end]);
      return pieces;
    });
  }
  return formatRange(ranges);
}

/**
 * One `@font-face`, self-hosted only (D-L43). There is deliberately no remote
 * URL parameter: a second `src` is how a third-party origin got back in.
 */
function renderFace({ family, localPath, style, weight, unicodeRange, display }) {
  const lines = [
    '@font-face {',
    `  font-family: '${family}';`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    `  font-display: ${display};`,
    `  src: url('${localPath}') format('woff2');`,
  ];
  if (unicodeRange) {
    lines.push(`  unicode-range: ${unicodeRange};`);
  }
  lines.push('}');
  return lines.join('\n');
}

async function main() {
  mkdirSync(fontDir, { recursive: true });

  const blocks = [
    '/* GENERATED FILE — do not edit. Source: pnpm ui:fetch-fonts */',
    '/*',
    ' * Self-hosted webfonts, and ONLY self-hosted: every src is a file under',
    ' * /fonts/ (D-L43). See packages/ui/scripts/fetch-fonts.mjs for why.',
    ' */',
    '',
  ];

  let downloaded = 0;

  for (const spec of FAMILIES) {
    const css = await fetchText(spec.css);
    const wanted = new Set(spec.subsets);
    const faces = parseFaces(css).filter((face) => wanted.has(face.subset));

    if (faces.length === 0) {
      throw new Error(
        `No wanted subsets found for ${spec.family}. Subsets seen: ` +
          parseFaces(css)
            .map((f) => f.subset)
            .join(', '),
      );
    }

    blocks.push(`/* ${spec.family} — ${spec.note} */`);

    if (spec.currency === true) {
      // Ahead of latin-ext, and carrying only the signs, so the small file is
      // the one a naira amount downloads (D-L44).
      const text = encodeURIComponent(String.fromCodePoint(...CURRENCY_CODE_POINTS));
      const currencyCss = await fetchText(`${spec.css}&text=${text}`);
      const [currencyFace] = parseFaces(currencyCss);
      if (currencyFace === undefined) {
        throw new Error(`No currency subset returned for ${spec.family}.`);
      }
      const fileName = `${spec.id}-currency-${currencyFace.weight.replace(/\s+/g, '')}.woff2`;
      const bytes = await fetchBinary(currencyFace.url);
      if (bytes.byteLength > CURRENCY_SUBSET_MAX_BYTES) {
        throw new Error(
          `${spec.family} currency subset is ${bytes.byteLength} bytes, over ` +
            `${CURRENCY_SUBSET_MAX_BYTES}; text= has stopped subsetting.`,
        );
      }
      writeFileSync(resolve(fontDir, fileName), bytes);
      downloaded += 1;
      blocks.push(
        renderFace({
          family: spec.family,
          localPath: `/fonts/${fileName}`,
          style: currencyFace.style,
          weight: currencyFace.weight,
          // Stated here rather than copied from the response: these are the
          // code points the file was asked for, and the ones carved out below.
          unicodeRange: formatRange(CURRENCY_CODE_POINTS.map((point) => [point, point])),
          display: 'swap',
        }),
      );
    }

    for (const face of faces) {
      const fileName = `${spec.id}-${face.subset}-${face.weight.replace(/\s+/g, '')}.woff2`;
      writeFileSync(resolve(fontDir, fileName), await fetchBinary(face.url));
      downloaded += 1;
      blocks.push(
        renderFace({
          family: spec.family,
          localPath: `/fonts/${fileName}`,
          style: face.style,
          weight: face.weight,
          unicodeRange:
            spec.currency === true && face.unicodeRange !== ''
              ? withoutCodePoints(face.unicodeRange, CURRENCY_CODE_POINTS)
              : face.unicodeRange,
          // Text must be readable while the font loads; on a slow connection
          // `block` means a blank screen.
          display: 'swap',
        }),
      );
    }
    blocks.push('');
  }

  // --- Material Symbols Rounded, subset to the icons the design uses --------
  const iconNames = readFileSync(iconListPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .sort();

  // The union of legal icon names, emitted next to the subset it describes.
  //
  // An icon that is not in the subset renders as a BLANK BOX — silently, only
  // in production, because the font file is fetched from the app's own origin
  // and nothing 404s. Free text would make that a runtime discovery; a union
  // makes it a compile error on the line that typed the name.
  writeFileSync(
    iconTypesOut,
    [
      '// GENERATED by packages/ui/scripts/fetch-fonts.mjs from icon-subset.txt.',
      '// Do not edit. Add the name to icon-subset.txt and run `pnpm ui:fetch-fonts`.',
      '',
      '/** Every glyph the self-hosted Material Symbols subset contains. */',
      'export type IconName =',
      ...iconNames.map((name) => `  | '${name}'`),
      '  ;',
      '',
      '/** The same list at runtime, for tests and for validating untyped input. */',
      'export const ICON_NAMES: readonly IconName[] = [',
      ...iconNames.map((name) => `  '${name}',`),
      '];',
      '',
    ].join('\n'),
    'utf8',
  );

  const iconCssUrl =
    'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0' +
    `&icon_names=${iconNames.join(',')}&display=block`;

  const iconCss = await fetchText(iconCssUrl);
  const iconFaces = parseFaces(iconCss);
  if (iconFaces.length === 0) {
    throw new Error('Material Symbols subset returned no @font-face.');
  }

  blocks.push(
    `/* Material Symbols Rounded — subset to the ${iconNames.length} icons the design uses */`,
  );
  for (const face of iconFaces) {
    const fileName = 'material-symbols-rounded-subset.woff2';
    writeFileSync(resolve(fontDir, fileName), await fetchBinary(face.url));
    downloaded += 1;
    blocks.push(
      renderFace({
        family: 'Material Symbols Rounded',
        localPath: `/fonts/${fileName}`,
        style: face.style,
        weight: face.weight,
        unicodeRange: face.unicodeRange,
        // Icons carry meaning; a fallback glyph would be a wrong symbol, so
        // block briefly rather than flash the wrong thing.
        display: 'block',
      }),
    );
  }

  blocks.push(
    '',
    '/* Ligature setup for the icon font. */',
    '.k-icon {',
    "  font-family: 'Material Symbols Rounded';",
    '  font-weight: normal;',
    '  font-style: normal;',
    '  line-height: 1;',
    '  letter-spacing: normal;',
    '  text-transform: none;',
    '  white-space: nowrap;',
    '  word-wrap: normal;',
    '  direction: ltr;',
    "  font-feature-settings: 'liga';",
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '',
  );

  writeFileSync(cssOut, blocks.join('\n'), 'utf8');
  process.stdout.write(`downloaded ${downloaded} font files -> ${fontDir}\nwrote ${cssOut}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
