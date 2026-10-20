import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FILLED_ICON_NAMES, ICON_NAMES } from './icons.generated';

/**
 * The generated font CSS, held to D-L43 and D-L44.
 *
 * D-L43: self-hosted ONLY. A `fonts.gstatic.com` fallback in a `src` list is a
 * third origin on a 256 kbps link and the user's IP sent to Google whenever a
 * local file fails — so no `url()` and no `@import` may name another origin.
 *
 * D-L44: the naira and cedi signs come from a small face. A face downloads when
 * the page uses a code point in its `unicode-range`, so the rule is about
 * ranges: no large file may claim ₦ or ₵.
 */

const css = readFileSync(resolve(__dirname, 'fonts.generated.css'), 'utf8');
const publicDir = resolve(__dirname, '..', '..', '..', 'apps', 'web', 'public');

interface Face {
  family: string;
  urls: string[];
  ranges: [number, number][] | undefined;
}

function faces(source: string): Face[] {
  return [...source.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((match) => {
    const body = match[1] ?? '';
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    return {
      family: /font-family:\s*'([^']+)'/.exec(body)?.[1] ?? '',
      urls: [...body.matchAll(/url\('([^']+)'\)/g)].map((url) => url[1] ?? ''),
      ranges:
        range === undefined
          ? undefined
          : range.split(',').map((part): [number, number] => {
              const [start, end] = part.trim().replace(/^U\+/i, '').split('-');
              const low = parseInt(start ?? '', 16);
              return [low, end === undefined ? low : parseInt(end, 16)];
            }),
    };
  });
}

function covers(face: Face, codePoint: number): boolean {
  return (
    face.ranges === undefined ||
    face.ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
  );
}

const NAIRA = 0x20a6;
const CEDI = 0x20b5;
const SMALL_FACE_MAX_BYTES = 20 * 1024;

describe('fonts.generated.css', () => {
  it('names no external origin, in any url() or @import (D-L43)', () => {
    const external = [
      ...css.matchAll(/url\(\s*['"]?((?:[a-z][\w+.-]*:)?\/\/[^'")]+)/gi),
      ...css.matchAll(/@import\s+(?:url\()?\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi),
    ].map((match) => match[1]);
    expect(external).toEqual([]);
    expect(css).not.toMatch(/fonts\.(gstatic|googleapis)\.com/);
  });

  it('gives every face exactly one source, under /fonts/, that is committed', () => {
    const all = faces(css);
    expect(all.length).toBeGreaterThan(0);
    for (const face of all) {
      expect(face.urls, `${face.family} has more than one src`).toHaveLength(1);
      for (const url of face.urls) {
        expect(url).toMatch(/^\/fonts\/[\w.-]+\.woff2$/);
        expect(statSync(resolve(publicDir, url.slice(1))).size).toBeGreaterThan(0);
      }
    }
  });

  it('draws ₦ and ₵ only from small files, and Noto Sans has a subset for them (D-L44)', () => {
    const all = faces(css);
    for (const codePoint of [NAIRA, CEDI]) {
      for (const face of all.filter((candidate) => covers(candidate, codePoint))) {
        for (const url of face.urls) {
          const bytes = statSync(resolve(publicDir, url.slice(1))).size;
          expect(
            bytes,
            `${face.family} claims U+${codePoint.toString(16)} with ${url}`,
          ).toBeLessThanOrEqual(SMALL_FACE_MAX_BYTES);
        }
      }
      expect(
        all.some(
          (face) =>
            face.family === 'Noto Sans' && face.ranges !== undefined && covers(face, codePoint),
        ),
      ).toBe(true);
    }
  });

  it('lists the currency subset ahead of Latin-Extended, and still ships Latin-Extended', () => {
    const currency = css.indexOf('noto-sans-currency-');
    const latinExt = css.indexOf('noto-sans-latin-ext-');
    expect(currency).toBeGreaterThan(-1);
    // Yorùbá, Igbo and Hausa diacritics live in Latin-Extended. It stays; it
    // just stops being the price of a currency sign.
    expect(latinExt).toBeGreaterThan(currency);
  });
});

/** The body of the first CSS rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  expect(at, `${selector} rule missing`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('}', at));
}

interface Woff2 {
  /** Table tags, in directory order. */
  tags: string[];
  /** Decompressed size matched the sum of the table directory's lengths. */
  consistent: boolean;
  ligatureCount: number;
  /** True if `name`, typed as text, is replaced by a ligature in the font. */
  hasLigature: (name: string) => boolean;
}

/**
 * Reads a WOFF2 far enough to answer "is this icon name a ligature here?":
 * the table directory, Brotli-decompressed tables, the `cmap` (formats 4 and
 * 12, all a Google Fonts subset carries) and every GSUB LigatureSubst (type 4,
 * or a type 7 extension wrapping one). node:zlib only, no dependency.
 */
function readWoff2(file: Buffer): Woff2 {
  // prettier-ignore
  const known = [
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
    'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
    'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
    'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
    'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
    'Gloc', 'Feat', 'Sill',
  ];
  expect(file.toString('latin1', 0, 4)).toBe('wOF2');
  let cursor = 48; // end of the WOFF2 header
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = file.readUInt8(cursor);
      cursor += 1;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('malformed UIntBase128');
  };

  const directory: { tag: string; offset: number; length: number }[] = [];
  let offset = 0;
  for (let i = 0; i < file.readUInt16BE(12); i += 1) {
    const flags = file.readUInt8(cursor);
    cursor += 1;
    let tag = known[flags & 0x3f] ?? '';
    if ((flags & 0x3f) === 63) {
      tag = file.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    }
    const version = (flags >> 6) & 3;
    const origLength = base128();
    // glyf/loca are transformed at version 0; every other table at non-zero.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128() : origLength;
    directory.push({ tag, offset, length });
    offset += length;
  }

  const data = brotliDecompressSync(file.subarray(cursor, cursor + file.readUInt32BE(20)));
  const table = (tag: string): Buffer => {
    const entry = directory.find((candidate) => candidate.tag === tag);
    if (entry === undefined) throw new Error(`no ${tag} table`);
    return data.subarray(entry.offset, entry.offset + entry.length);
  };

  const cmap = table('cmap');
  const glyphOf = new Map<number, number>();
  for (let i = 0; i < cmap.readUInt16BE(2); i += 1) {
    const sub = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let seg = 0; seg < segX2 / 2; seg += 1) {
        const end = cmap.readUInt16BE(ends + seg * 2);
        const start = cmap.readUInt16BE(starts + seg * 2);
        const delta = cmap.readInt16BE(deltas + seg * 2);
        const rangeOffset = cmap.readUInt16BE(rangeOffsets + seg * 2);
        for (let code = start; code <= end && code !== 0xffff; code += 1) {
          let glyph = 0;
          if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
          else {
            const at = rangeOffsets + seg * 2 + rangeOffset + (code - start) * 2;
            const raw = cmap.readUInt16BE(at);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0) glyphOf.set(code, glyph);
        }
      }
    } else if (format === 12) {
      for (let group = 0; group < cmap.readUInt32BE(sub + 12); group += 1) {
        const first = cmap.readUInt32BE(sub + 16 + group * 12);
        const last = cmap.readUInt32BE(sub + 20 + group * 12);
        const startGlyph = cmap.readUInt32BE(sub + 24 + group * 12);
        for (let code = first; code <= last; code += 1)
          glyphOf.set(code, startGlyph + code - first);
      }
    }
  }

  const gsub = table('GSUB');
  const coverage = (at: number): number[] => {
    const glyphs: number[] = [];
    const count = gsub.readUInt16BE(at + 2);
    if (gsub.readUInt16BE(at) === 1) {
      for (let i = 0; i < count; i += 1) glyphs.push(gsub.readUInt16BE(at + 4 + i * 2));
    } else {
      for (let i = 0; i < count; i += 1) {
        const last = gsub.readUInt16BE(at + 6 + i * 6);
        for (let g = gsub.readUInt16BE(at + 4 + i * 6); g <= last; g += 1) glyphs.push(g);
      }
    }
    return glyphs;
  };
  const ligatures = new Set<string>();
  const lookupList = gsub.readUInt16BE(8);
  for (let i = 0; i < gsub.readUInt16BE(lookupList); i += 1) {
    const lookup = lookupList + gsub.readUInt16BE(lookupList + 2 + i * 2);
    for (let s = 0; s < gsub.readUInt16BE(lookup + 4); s += 1) {
      let sub = lookup + gsub.readUInt16BE(lookup + 6 + s * 2);
      let type = gsub.readUInt16BE(lookup);
      if (type === 7) {
        type = gsub.readUInt16BE(sub + 2);
        sub += gsub.readUInt32BE(sub + 4);
      }
      if (type !== 4) continue;
      const firsts = coverage(sub + gsub.readUInt16BE(sub + 2));
      for (let k = 0; k < gsub.readUInt16BE(sub + 4); k += 1) {
        const set = sub + gsub.readUInt16BE(sub + 6 + k * 2);
        for (let m = 0; m < gsub.readUInt16BE(set); m += 1) {
          const lig = set + gsub.readUInt16BE(set + 2 + m * 2);
          const components = [firsts[k] ?? -1];
          for (let q = 1; q < gsub.readUInt16BE(lig + 2); q += 1) {
            components.push(gsub.readUInt16BE(lig + 2 + q * 2));
          }
          ligatures.add(components.join(','));
        }
      }
    }
  }

  return {
    tags: directory.map((entry) => entry.tag),
    consistent: offset === data.length,
    ligatureCount: ligatures.size,
    hasLigature: (name) => {
      const glyphs = [...name].map((char) => glyphOf.get(char.codePointAt(0) ?? -1));
      return !glyphs.includes(undefined) && ligatures.has(glyphs.join(','));
    },
  };
}

/** A name list: blank lines and `#` comments ignored, each line trimmed, sorted. */
function list(file: string): string[] {
  return readFileSync(resolve(__dirname, '..', file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .sort();
}

/**
 * Icons (T-0127, D-L198). The main face is static FILL 0 and holds every listed
 * glyph; a second, small face holds only the filled glyphs, with the FILL axis,
 * and downloads only on a page that draws one. That split saves about 8.6 KB on
 * every page against shipping the axis on the main face.
 */
describe('fonts.generated.css: icons', () => {
  const font = (name: string) => readFileSync(resolve(publicDir, 'fonts', name));

  it('lets an icon inherit the weight around it, as the exports render (D-L198)', () => {
    // The Claude Design exports set no weight on the icon: it inherits the
    // text's 600 or 700 and the browser synthesises bold from the weight-400
    // face. The defect T-0127 fixed was a type class imposing its OWN weight on
    // the icon, not inheritance, so neither a pinned weight nor a synthesis
    // ban belongs here.
    const icon = rule(css, '.k-icon');
    expect(icon).not.toMatch(/font-weight/);
    expect(icon).not.toMatch(/font-synthesis/);
  });

  it('draws the filled variant from the filled face at FILL 1', () => {
    const filled = rule(css, '.k-icon-filled');
    // The outline face second, so a failed load shows the outline, not the word.
    expect(filled).toContain(
      "font-family: 'Material Symbols Rounded Filled', 'Material Symbols Rounded';",
    );
    expect(filled).toContain("font-variation-settings: 'FILL' 1;");
    expect(css.indexOf('\n.k-icon-filled {')).toBeGreaterThan(css.indexOf('\n.k-icon {'));
  });

  it('ships the main face static and only the filled face with variation axes', () => {
    const urls = Object.fromEntries(faces(css).map((face) => [face.family, face.urls[0] ?? '']));
    expect(urls['Material Symbols Rounded']).toBe('/fonts/material-symbols-rounded-subset.woff2');
    expect(urls['Material Symbols Rounded Filled']).toBe(
      '/fonts/material-symbols-rounded-filled-subset.woff2',
    );
    expect(readWoff2(font('material-symbols-rounded-subset.woff2')).tags).not.toContain('fvar');
    expect(readWoff2(font('material-symbols-rounded-filled-subset.woff2')).tags).toContain('fvar');
  });

  it('keeps every filled glyph in the main subset too, so filled={false} is never blank', () => {
    expect(FILLED_ICON_NAMES.length).toBeGreaterThan(0);
    expect(FILLED_ICON_NAMES.filter((name) => !ICON_NAMES.includes(name))).toEqual([]);
  });

  it('generated the unions from the committed lists (a list edited without re-fetching fails)', () => {
    expect([...ICON_NAMES]).toEqual(list('icon-subset.txt'));
    expect([...FILLED_ICON_NAMES]).toEqual(list('icon-subset-filled.txt'));
  });

  // Each listed name must be a ligature in ITS face. A name typed into a list
  // without `pnpm ui:fetch-fonts` is a blank box in production; the T-0006
  // acceptance suite checks the main face only, so the filled face is checked
  // here, and the main one alongside it.
  it.each([
    ['icon-subset.txt', 'material-symbols-rounded-subset.woff2'],
    ['icon-subset-filled.txt', 'material-symbols-rounded-filled-subset.woff2'],
  ])('every name in %s is a ligature in %s', (names, woff2) => {
    const face = readWoff2(font(woff2));
    expect(face.consistent, 'table directory disagrees with the decompressed data').toBe(true);
    expect(face.ligatureCount).toBeGreaterThanOrEqual(list(names).length);
    expect(list(names).filter((name) => !face.hasLigature(name))).toEqual([]);
  });

  it('the ligature reader rejects real glyphs that were never subset', () => {
    // Without this, a reader that said yes to everything would pass the above.
    const main = readWoff2(font('material-symbols-rounded-subset.woff2'));
    const filled = readWoff2(font('material-symbols-rounded-filled-subset.woff2'));
    for (const absent of ['rocket_launch', 'pets', 'arrow']) {
      expect(main.hasLigature(absent), absent).toBe(false);
    }
    // In the main face, not the filled one: the filled face really is a subset.
    expect(main.hasLigature('search')).toBe(true);
    expect(filled.hasLigature('search')).toBe(false);
    expect(filled.hasLigature('notifications')).toBe(true);
  });
});
