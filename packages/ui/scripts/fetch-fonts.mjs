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
 * Google Fonts stays in the `src` list as a genuine fallback: if the local file
 * 404s after a bad deploy, the browser tries the CDN before giving up.
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

function renderFace({ family, localPath, remoteUrl, style, weight, unicodeRange, display }) {
  const lines = [
    '@font-face {',
    `  font-family: '${family}';`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    `  font-display: ${display};`,
    `  src:`,
    `    url('${localPath}') format('woff2'),`,
    `    url('${remoteUrl}') format('woff2');`,
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
    ' * Self-hosted webfonts. Google Fonts is listed second in each src as a',
    ' * fallback only — see packages/ui/scripts/fetch-fonts.mjs for why.',
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

    for (const face of faces) {
      const fileName = `${spec.id}-${face.subset}-${face.weight.replace(/\s+/g, '')}.woff2`;
      writeFileSync(resolve(fontDir, fileName), await fetchBinary(face.url));
      downloaded += 1;
      blocks.push(
        renderFace({
          family: spec.family,
          localPath: `/fonts/${fileName}`,
          remoteUrl: face.url,
          style: face.style,
          weight: face.weight,
          unicodeRange: face.unicodeRange,
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
        remoteUrl: face.url,
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
