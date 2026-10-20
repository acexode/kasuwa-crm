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
 * MONO FIGURES AND LETTERS (T-0145)
 *
 * JetBrains Mono draws amounts, phone numbers, ids and the shell's "Ctrl K"
 * hint. Google's Latin file is 31 KB, almost all of it the code ligatures that
 * punctuation pairs build (`->`, `!=`, `::`), and one hint in the top bar was
 * downloading all of it on every CRM screen; a `₦` added the 11.6 KB
 * Latin-Extended file on top. So the face is carved like D-L44's currency
 * signs, into small `text=` subsets listed ahead of the large files:
 *
 *   figures  what nearly every screen draws: digits, the separators of an
 *            amount, a phone number, a date and a range, the currency signs,
 *            the bullet a masked password is drawn with, and the five letters
 *            of "Ctrl K". It also holds the SPACE: an element in a mono face
 *            downloads the face covering U+0020 for its line metrics even when
 *            it is empty (the sign-in password box), so the space has to live
 *            in the smallest file.
 *   capitals the other capitals: currency codes, compact suffixes and ids
 *            (`KES 75K`, `₦37.9M`, `PRG-0031`).
 *   letters  the other lowercase letters, and the characters of an identifier
 *            or a merge field (`owner_user_id`, `{contact.displayName}`).
 *
 * The Latin and Latin-Extended files stay, minus those code points, for the
 * rest of the punctuation and accented letters. A face downloads only when the
 * page draws a code point in its range, so a screen of numbers costs about
 * 7 KB of mono instead of 43 KB. The glyphs are the same glyphs from the same
 * release, so nothing renders differently: Google serves `text=` subsets with
 * the same tables, unhinted, as its per-script files.
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
const filledListPath = resolve(root, 'packages/ui/icon-subset-filled.txt');
const iconTypesOut = resolve(root, 'packages/ui/src/icons.generated.ts');

// A browser user agent is required, or Google Fonts serves TTF instead of the
// far smaller woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** ₦ (naira) and ₵ (cedi): the signs D-L44 found pulling in Latin-Extended. */
const CURRENCY_TEXT = '\u20A6\u20B5';

/**
 * JetBrains Mono's small face (T-0145): the space, which makes it the face an
 * empty mono field downloads for its metrics; the no-break, narrow no-break
 * and thin spaces `Intl` formats with; digits; the separators of an amount, a
 * phone number, a date, a time and a range (`+ , - . / : % ( )`, en and em
 * dash, minus sign, multiplication sign); the currency signs; the bullet a
 * masked password is drawn with; and C, K, l, r and t, the letters of the
 * shell's "Ctrl K" hint, which is on every CRM screen.
 */
const MONO_FIGURES_TEXT =
  ' \u00A0\u202F\u2009' +
  '0123456789' +
  '+,-./:%()' +
  '\u2013\u2014\u2212\u00D7' +
  '$\u00A3\u20AC\u20A6\u20B5' +
  '\u2022' +
  'CKlrt';

/**
 * The other capitals: a currency code (`KES 75K`, `GH₵`), a compact amount's
 * suffix (`₦37.9M`), an id (`PRG-0031`). Apart from the lowercase letters, so
 * the board's amounts do not download the lowercase.
 */
const MONO_CAPITALS_TEXT = 'ABDEFGHIJLMNOPQRSTUVWXYZ';

/** The other lowercase letters, and what an identifier or a merge field adds. */
const MONO_LETTERS_TEXT = 'abcdefghijkmnopqsuvwxyz' + '_@{}\u2019';

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
    carveOuts: [{ name: 'currency', text: CURRENCY_TEXT }],
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
    // T-0145: figures and letters carved out of latin and latin-ext.
    carveOuts: [
      { name: 'figures', text: MONO_FIGURES_TEXT },
      { name: 'capitals', text: MONO_CAPITALS_TEXT },
      { name: 'letters', text: MONO_LETTERS_TEXT },
    ],
  },
];

/** The code points of a `text=` string, ascending and unique. */
function codePointsOf(text) {
  return [...new Set([...text].map((char) => char.codePointAt(0)))].sort((a, b) => a - b);
}

/** Ascending code points -> the shortest list of `[start, end]` spans. */
function spansOf(points) {
  const ranges = [];
  for (const point of points) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === point - 1) last[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}

/**
 * A carved subset is a handful of glyphs. Anything near the size of the file
 * it replaces means `text=` stopped subsetting, and shipping it would put the
 * large file back on every screen that draws one of its characters (for the
 * currency signs, the 168 KB Latin-Extended file).
 */
const CARVED_SUBSET_MAX_BYTES = 20 * 1024;

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

/** A name list: blank lines and `#` comments ignored, each line trimmed, sorted. */
function readNames(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .sort();
}

/**
 * The `unicode-range` of an icon face. It is used through ligatures alone, so
 * it needs only the characters the names are spelled with, plus the space (the
 * "first available font" for an element's line metrics must cover U+0020, or
 * the icon's baseline would come from a fallback font). Google sends no range
 * for an icon subset, which made the face claim every code point, including
 * the naira and cedi signs D-L44 keeps on small files only.
 */
function ligatureRange(names) {
  return formatRange(spansOf(codePointsOf(` ${names.join('')}`)));
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

    // Carved subsets first (D-L44, T-0145): each a `text=` request for a few
    // code points, which are then cut out of the large faces' ranges so no
    // large file claims them. The carve-outs of one family never overlap.
    const carveOuts = spec.carveOuts ?? [];
    const carved = [];
    for (const carveOut of carveOuts) {
      const points = codePointsOf(carveOut.text);
      const clash = points.filter((point) => carved.includes(point));
      if (clash.length > 0) {
        throw new Error(
          `${spec.family}: carve-out ${carveOut.name} repeats ${clash.map(hex).join(', ')}.`,
        );
      }
      carved.push(...points);
      const carvedCss = await fetchText(`${spec.css}&text=${encodeURIComponent(carveOut.text)}`);
      const [carvedFace] = parseFaces(carvedCss);
      if (carvedFace === undefined) {
        throw new Error(`No ${carveOut.name} subset returned for ${spec.family}.`);
      }
      const fileName = `${spec.id}-${carveOut.name}-${carvedFace.weight.replace(/\s+/g, '')}.woff2`;
      const bytes = await fetchBinary(carvedFace.url);
      if (bytes.byteLength > CARVED_SUBSET_MAX_BYTES) {
        throw new Error(
          `${spec.family} ${carveOut.name} subset is ${bytes.byteLength} bytes, over ` +
            `${CARVED_SUBSET_MAX_BYTES}; text= has stopped subsetting.`,
        );
      }
      writeFileSync(resolve(fontDir, fileName), bytes);
      downloaded += 1;
      blocks.push(
        renderFace({
          family: spec.family,
          localPath: `/fonts/${fileName}`,
          style: carvedFace.style,
          weight: carvedFace.weight,
          // Stated here rather than copied from the response: these are the
          // code points the file was asked for, and the ones carved out below.
          unicodeRange: formatRange(spansOf(points)),
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
            carved.length > 0 && face.unicodeRange !== ''
              ? withoutCodePoints(face.unicodeRange, carved)
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
  //
  // Two faces (T-0127, D-L198), because bytes on every page are the scarce
  // thing at 256 kbps:
  //
  //   'Material Symbols Rounded'         every listed glyph, static FILL 0.
  //   'Material Symbols Rounded Filled'  only icon-subset-filled.txt, with the
  //                                      FILL axis; `.k-icon-filled` draws it at
  //                                      FILL 1. A face downloads only when an
  //                                      element uses its family, so a page with
  //                                      no filled icon never fetches it.
  //
  // Shipping the axis on the main face instead would cost about 8.6 KB more on
  // every page. The price of the split is a second list, and a filled name
  // outside it renders as a blank box, so the generated `FilledIconName` union
  // and `pnpm verify:icons` both check it, and every filled name must also be
  // in the main list (checked below), so `filled={false}` is always safe.
  const iconNames = readNames(iconListPath);
  const filledNames = readNames(filledListPath);
  const strays = filledNames.filter((name) => !iconNames.includes(name));
  if (strays.length > 0) {
    throw new Error(
      `icon-subset-filled.txt lists ${strays.join(', ')}, which icon-subset.txt does not. ` +
        'Every filled glyph must also be in the main subset.',
    );
  }

  // The unions of legal icon names, emitted next to the subsets they describe.
  //
  // An icon that is not in the subset renders as a BLANK BOX — silently, only
  // in production, because the font file is fetched from the app's own origin
  // and nothing 404s. Free text would make that a runtime discovery; a union
  // makes it a compile error on the line that typed the name.
  writeFileSync(
    iconTypesOut,
    [
      '// GENERATED by packages/ui/scripts/fetch-fonts.mjs from icon-subset.txt',
      '// and icon-subset-filled.txt. Do not edit. Add the name to the list and run',
      '// `pnpm ui:fetch-fonts`.',
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
      '/**',
      ' * The glyphs the filled face contains: the only names `<Icon filled>` takes.',
      ' * Every one is also an `IconName`.',
      ' */',
      'export type FilledIconName =',
      ...filledNames.map((name) => `  | '${name}'`),
      '  ;',
      '',
      '/** The same list at runtime. */',
      'export const FILLED_ICON_NAMES: readonly FilledIconName[] = [',
      ...filledNames.map((name) => `  '${name}',`),
      '];',
      '',
    ].join('\n'),
    'utf8',
  );

  // opsz, wght and GRAD stay pinned: the design uses 24/400/0 only. The main
  // face is static FILL 0; the filled face carries FILL 0..1 and is drawn at 1.
  const iconFaceSpecs = [
    {
      names: iconNames,
      family: 'Material Symbols Rounded',
      fileName: 'material-symbols-rounded-subset.woff2',
      axes: 'opsz,wght,FILL,GRAD@24,400,0,0',
      note: `subset to the ${iconNames.length} icons the design uses, FILL 0`,
    },
    {
      names: filledNames,
      family: 'Material Symbols Rounded Filled',
      fileName: 'material-symbols-rounded-filled-subset.woff2',
      axes: 'opsz,wght,FILL,GRAD@24,400,0..1,0',
      note: `the ${filledNames.length} glyphs the design draws filled, FILL axis`,
    },
  ];

  for (const spec of iconFaceSpecs) {
    const iconCssUrl =
      `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:${spec.axes}` +
      `&icon_names=${spec.names.join(',')}&display=block`;
    const iconFaces = parseFaces(await fetchText(iconCssUrl));
    if (iconFaces.length === 0) {
      throw new Error(`${spec.family} subset returned no @font-face.`);
    }

    blocks.push(`/* ${spec.family} — ${spec.note} */`);
    for (const face of iconFaces) {
      writeFileSync(resolve(fontDir, spec.fileName), await fetchBinary(face.url));
      downloaded += 1;
      blocks.push(
        renderFace({
          family: spec.family,
          localPath: `/fonts/${spec.fileName}`,
          style: face.style,
          weight: face.weight,
          unicodeRange: face.unicodeRange !== '' ? face.unicodeRange : ligatureRange(spec.names),
          // Icons carry meaning; a fallback glyph would be a wrong symbol, so
          // block briefly rather than flash the wrong thing.
          display: 'block',
        }),
      );
    }
    blocks.push('');
  }

  blocks.push(
    '/* Ligature setup for the icon font. */',
    '/*',
    ' * No font-weight here, deliberately (T-0127, D-L198): an icon inherits the',
    ' * weight of the text around it and the browser synthesises bold from the',
    ' * weight-400 face, exactly as the Claude Design exports render. What made',
    ' * glyphs wrongly heavy was a type-scale class on the icon imposing its own',
    ' * weight; icon sizes are now text-icon-* utilities, which set a size only.',
    ' */',
    '.k-icon {',
    "  font-family: 'Material Symbols Rounded';",
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
    '/* The filled variant: active bottom-tab icons, the bell, gpp_maybe. */',
    '.k-icon-filled {',
    // The outline face second: if the filled file fails to load, the glyph
    // degrades to its outline rather than to the raw ligature word.
    "  font-family: 'Material Symbols Rounded Filled', 'Material Symbols Rounded';",
    "  font-variation-settings: 'FILL' 1;",
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
