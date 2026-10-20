import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** WOFF2 table tags, from the directory alone (no decompression needed). */
function woff2Tags(file: Buffer): string[] {
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
  let cursor = 48;
  const base128 = (): void => {
    for (let i = 0; i < 5; i += 1) {
      const byte = file.readUInt8(cursor);
      cursor += 1;
      if ((byte & 0x80) === 0) return;
    }
  };
  const tags: string[] = [];
  for (let i = 0; i < file.readUInt16BE(12); i += 1) {
    const flags = file.readUInt8(cursor);
    cursor += 1;
    let tag = known[flags & 0x3f] ?? '';
    if ((flags & 0x3f) === 63) {
      tag = file.toString('latin1', cursor, cursor + 4);
      cursor += 4;
    }
    const version = (flags >> 6) & 3;
    base128();
    if (tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0) base128();
    tags.push(tag);
  }
  return tags;
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
    expect(filled).toContain("font-family: 'Material Symbols Rounded Filled';");
    expect(filled).toContain("font-variation-settings: 'FILL' 1;");
    expect(css.indexOf('\n.k-icon-filled {')).toBeGreaterThan(css.indexOf('\n.k-icon {'));
  });

  it('ships the main face static and only the filled face with variation axes', () => {
    const urls = Object.fromEntries(faces(css).map((face) => [face.family, face.urls[0] ?? '']));
    expect(urls['Material Symbols Rounded']).toBe('/fonts/material-symbols-rounded-subset.woff2');
    expect(urls['Material Symbols Rounded Filled']).toBe(
      '/fonts/material-symbols-rounded-filled-subset.woff2',
    );
    expect(woff2Tags(font('material-symbols-rounded-subset.woff2'))).not.toContain('fvar');
    expect(woff2Tags(font('material-symbols-rounded-filled-subset.woff2'))).toContain('fvar');
  });

  it('keeps every filled glyph in the main subset too, so filled={false} is never blank', () => {
    expect(FILLED_ICON_NAMES.length).toBeGreaterThan(0);
    expect(FILLED_ICON_NAMES.filter((name) => !ICON_NAMES.includes(name))).toEqual([]);
  });

  it('generated the unions from the committed lists (a list edited without re-fetching fails)', () => {
    const list = (file: string) =>
      readFileSync(resolve(__dirname, '..', file), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .sort();
    expect([...ICON_NAMES]).toEqual(list('icon-subset.txt'));
    expect([...FILLED_ICON_NAMES]).toEqual(list('icon-subset-filled.txt'));
  });
});
