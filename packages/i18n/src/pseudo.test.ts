import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { createTranslator, PSEUDO_LOCALE } from './index';
import { pseudoCatalogue, pseudoMessage } from './pseudo';
import en from './locales/en.json';

describe('the en-XA pseudo-locale (T-0042)', () => {
  it('accents, brackets and pads plain text', () => {
    expect(pseudoMessage('Contacts')).toBe('[Cöntäcts···]');
  });

  it('leaves a simple placeholder verbatim', () => {
    expect(pseudoMessage('Hello {name}')).toMatch(/^\[Hëllö \{name\}·+\]$/);
  });

  it('keeps plural keywords and argument names, accenting only branch text', () => {
    const out = pseudoMessage('{count, plural, one {# step} other {# steps}}');
    expect(out).toContain('{count, plural, one {# stëp} other {# stëps}}');
    expect(new IntlMessageFormat(out, 'en').format({ count: 2 })).toContain('stëps');
  });

  it('produces a catalogue in which every English message still parses', () => {
    const catalogue = pseudoCatalogue(en);
    const broken = Object.entries(catalogue).filter(([, message]) => {
      try {
        new IntlMessageFormat(message, 'en');
        return false;
      } catch {
        return true;
      }
    });
    expect(broken.map(([id]) => id)).toEqual([]);
  });

  it('is what the translator renders for en-XA, with no generated file', () => {
    expect(createTranslator(PSEUDO_LOCALE).t('app.name')).toBe(pseudoMessage(en['app.name']));
  });
});
