import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTERED_LOCALES, bundleMessages } from '@kasuwa/i18n';
import { ADMIN_STUDIO_MESSAGE_IDS } from './message-ids';

/**
 * The studio asks for a message id it did not bundle and the route throws at
 * request time, in whichever language the person chose (see
 * `../message-ids.test.ts`, where this lesson was learned on the P02 shell).
 *
 * This reads the SOURCE of every module in this directory and checks every
 * literal message id in it is bundled. A computed id is impossible here by
 * design: `studio-text.ts` writes each one out whole, so this check sees them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ID = /['"`]((?:admin|auth)\.[\w-]+(?:\.[\w-]+)+)['"`]/g;

describe('the customisation studio bundles the ids it renders', () => {
  const bundled = new Set<string>(ADMIN_STUDIO_MESSAGE_IDS);

  for (const file of readdirSync(here).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'message-ids.ts')) {
    it(`${file} asks for nothing it did not bundle`, () => {
      const source = readFileSync(resolve(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const ids = [...new Set([...source.matchAll(ID)].map((match) => match[1] ?? ''))];
      expect(ids.filter((id) => !bundled.has(id)), `${file} names ids that are not in the bundle`).toEqual([]);
    });
  }

  it('resolves in every registered locale', () => {
    for (const locale of REGISTERED_LOCALES) {
      expect(() => bundleMessages(locale, ADMIN_STUDIO_MESSAGE_IDS), locale).not.toThrow();
    }
  });
});
