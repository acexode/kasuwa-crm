import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTERED_LOCALES, bundleMessages, createBundleTranslator, type MessageId } from '@kasuwa/i18n';
import { CONTACT_RECORD_MESSAGE_IDS } from '../contact-record/message-ids';
import { LEADS_MESSAGE_IDS } from '../leads/message-ids';

/**
 * T-0103 (D-P23): a former owner arrives as `owner: { id, displayName: null }`.
 * The leads rows and the contact record print the translated neutral label
 * `records.owner.former` instead: never a blank, never the id, never
 * "Unassigned" (the owner id is set; the person has left the programme).
 */

const FORMER: MessageId = 'records.owner.former';
const UNASSIGNED: MessageId = 'records.owner.unassigned';
const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(resolve(here, file), 'utf8');

const SCREENS = [
  { name: 'leads', ids: LEADS_MESSAGE_IDS, renderer: '../leads/lead-parts.tsx' },
  { name: 'contact record', ids: CONTACT_RECORD_MESSAGE_IDS, renderer: '../contact-record/contact-record-screen.tsx' },
] as const;

describe('the former-owner label (T-0103)', () => {
  for (const screen of SCREENS) {
    it(`the ${screen.name} screen bundles it and its renderer prints it for a null name`, () => {
      expect(screen.ids).toContain(FORMER);
      const text = source(screen.renderer);
      expect(text).toContain(`t.t('${FORMER}')`);
      // The branch is keyed on the null name, and marks the cell for the screens' tests.
      expect(text).toMatch(/displayName === null/);
      expect(text).toContain('data-owner="former"');
    });

    it(`the ${screen.name} bundle resolves it in every registered locale, as plain text`, () => {
      for (const locale of REGISTERED_LOCALES) {
        const t = createBundleTranslator(locale, bundleMessages(locale, screen.ids));
        const label = t.t(FORMER);
        expect(label.trim().length, locale).toBeGreaterThan(0);
        // No placeholder: the label cannot be handed the id, or anything else.
        expect(label, locale).not.toMatch(/[{}]/);
        expect(label, `${locale}: must not read as "Unassigned"`).not.toBe(t.t(UNASSIGNED));
      }
    });
  }

  it('reads "Former owner" in English', () => {
    const t = createBundleTranslator('en', bundleMessages('en', [FORMER]));
    expect(t.t(FORMER)).toBe('Former owner');
  });
});
