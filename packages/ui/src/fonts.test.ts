import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
