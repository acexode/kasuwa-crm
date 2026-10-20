import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import {
  ADMIN_AUDIT_MESSAGE_IDS,
  ADMIN_FLS_MESSAGE_IDS,
  ADMIN_HOME_MESSAGE_IDS,
  ADMIN_PROGRAMMES_MESSAGE_IDS,
  ADMIN_PROGRAMME_MESSAGE_IDS,
  ADMIN_ROLES_MESSAGE_IDS,
  ADMIN_SHELL_MESSAGE_IDS,
} from './message-ids';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, on the server, in whichever language the person chose.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS, WRITTEN THE DAY IT WAS NEEDED
 *
 * `AdminShell` rendered `t.t('admin.prog.unknown')` for the residency badge and
 * that id was not in `ADMIN_SHELL_MESSAGE_IDS`. Every admin route threw on
 * first render. Nothing caught it: `tsc` is happy because the id is a valid
 * `MessageId`, and lint has no opinion about which bundle a screen asked for.
 * It took a fourteen-minute end-to-end run to find, and it presented as twenty
 * unrelated-looking failures.
 *
 * So the check moved into the fast suite, where it costs milliseconds. It reads
 * the component SOURCE rather than rendering anything, because rendering these
 * screens needs a DOM, a router and a fetch, and none of that is the bug.
 * ---------------------------------------------------------------------------
 *
 * It cannot see a computed id — `t.t(\`admin.prog.status.${x}\`)` — and it does
 * not try to. Those are cast through `as MessageId` at the call site and each
 * one has its whole enum listed in the bundle by hand; the e2e suite is what
 * covers them.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Which bundle each screen module is rendered with. */
const SCREENS: Readonly<Record<string, readonly MessageId[]>> = {
  'admin-shell.tsx': ADMIN_SHELL_MESSAGE_IDS,
  'panel.tsx': ADMIN_SHELL_MESSAGE_IDS,
  // T-0145: the slow-network state, out of panel.tsx so CRM screens skip the rest of it.
  'still-connecting.tsx': ADMIN_SHELL_MESSAGE_IDS,
  'home-screen.tsx': ADMIN_HOME_MESSAGE_IDS,
  'programmes-screen.tsx': ADMIN_PROGRAMMES_MESSAGE_IDS,
  'programme-screen.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'agents-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'sla-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'dispositions-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'scripts-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'retention-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'portal-tab.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'archive-dialog.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'sample-data.tsx': ADMIN_PROGRAMME_MESSAGE_IDS,
  'roles-screen.tsx': ADMIN_ROLES_MESSAGE_IDS,
  'field-security-screen.tsx': ADMIN_FLS_MESSAGE_IDS,
  'audit-screen.tsx': ADMIN_AUDIT_MESSAGE_IDS,
};

function literalIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  return [...new Set([...source.matchAll(/t\.t\(\s*'([^']+)'/g)].map((match) => match[1] ?? ''))];
}

describe('every admin screen bundles the ids it renders', () => {
  it('covers every component in this directory that calls `t.t`', () => {
    // A new screen added without an entry above would otherwise be checked by
    // nothing at all, which is the failure mode one directory over.
    const unchecked = readdirSync(here).filter(
      (file) =>
        file.endsWith('.tsx') &&
        !(file in SCREENS) &&
        /t\.t\(\s*'/.test(readFileSync(resolve(here, file), 'utf8')),
    );
    expect(unchecked, 'components calling t.t with no bundle declared').toEqual([]);
  });

  for (const [file, bundle] of Object.entries(SCREENS)) {
    it(`${file} asks for nothing it did not bundle`, () => {
      const available = new Set<string>(bundle);
      const missing = literalIds(file).filter((id) => !available.has(id));
      expect(missing, `${file} renders ids that are not in its bundle`).toEqual([]);
    });
  }
});

describe('every admin bundle resolves', () => {
  for (const [name, bundle] of Object.entries({
    ADMIN_SHELL_MESSAGE_IDS,
    ADMIN_HOME_MESSAGE_IDS,
    ADMIN_PROGRAMMES_MESSAGE_IDS,
    ADMIN_PROGRAMME_MESSAGE_IDS,
    ADMIN_ROLES_MESSAGE_IDS,
    ADMIN_FLS_MESSAGE_IDS,
    ADMIN_AUDIT_MESSAGE_IDS,
  })) {
    it(`${name} resolves in every registered locale`, () => {
      // `bundleMessages` throws on a missing id, so this is the same thing the
      // server does on every request — run once, for nine languages, in
      // milliseconds, instead of for one language in a browser.
      for (const locale of REGISTERED_LOCALES) {
        expect(() => bundleMessages(locale, bundle), `${name} in ${locale}`).not.toThrow();
      }
    });
  }
});
