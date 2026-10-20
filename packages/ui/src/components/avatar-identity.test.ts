import { describe, expect, it } from 'vitest';
import { AVATAR_TONES, avatarTone, hashSeed, initials } from './avatar-identity';

describe('initials', () => {
  it('takes the first letter of the first and last words', () => {
    expect(initials('Adaeze Okonkwo')).toBe('AO');
    expect(initials('Kwame Kofi Mensah')).toBe('KM');
    expect(initials('  Tunde   Bakare ')).toBe('TB');
  });

  it('gives one initial for one word', () => {
    expect(initials('Wanjiru')).toBe('W');
  });

  it('keeps tone marks with their letter', () => {
    // "Ọ" is O + U+0323 (dot below). Both must survive, and nothing may dangle.
    expect(initials('Ọláńrewájú Adébáyọ̀')).toBe('ỌA');
    expect(initials('ọlá ẹ̀kọ́')).toBe('ỌẸ̀');
    expect(initials('Ɗanladi Ƙaura')).toBe('ƊƘ');
  });

  it('treats precomposed and decomposed spellings as the same letters', () => {
    const decomposed = 'Émeka Obi';
    const precomposed = 'Émeka Obi';
    expect(initials(decomposed)).toBe(initials(precomposed));
  });

  it('skips leading punctuation and words with no letter', () => {
    expect(initials('(Bayo) Ade')).toBe('BA');
    expect(initials('Kemi — 2')).toBe('K');
    expect(initials('— 42')).toBe('');
    expect(initials('')).toBe('');
  });

  it('uppercases for the locale it is given', () => {
    // Turkish dotted i: a locale-blind toUpperCase gives "I".
    expect(initials('ilknur yılmaz', 'tr')).toBe('İY');
    expect(initials('aïssatou diallo', 'fr')).toBe('AD');
  });

  it('works for Arabic script, which has no case', () => {
    expect(initials('محمد علي')).toBe('مع');
  });
});

describe('avatarTone', () => {
  it('is one of the four v1.1 fills', () => {
    expect(AVATAR_TONES).toEqual(['primary', 'accent', 'info', 'success']);
    expect(AVATAR_TONES).toContain(avatarTone('Adaeze Okonkwo'));
  });

  it('is stable: the same seed is the same colour every time', () => {
    for (const seed of ['Adaeze Okonkwo', 'user_01J9Z', 'محمد علي']) {
      expect(avatarTone(seed)).toBe(avatarTone(seed));
    }
  });

  it('is pinned, so a change to the hash is a visible decision', () => {
    // FNV-1a 32-bit over code points. Changing it recolours every person in
    // the product; this test makes that a deliberate edit, not an accident.
    expect(hashSeed('')).toBe(0x811c9dc5);
    expect(hashSeed('a')).toBe(0xe40c292c);
    expect(avatarTone('Adaeze Okonkwo')).toBe(AVATAR_TONES[hashSeed('Adaeze Okonkwo') % 4]);
  });

  it('ignores how a diacritic was typed', () => {
    expect(avatarTone('Émeka Obi')).toBe(avatarTone('Émeka Obi'));
  });

  it('uses every fill across a realistic set of names', () => {
    const names = [
      'Adaeze Okonkwo',
      'Kwame Mensah',
      'Wanjiru Kamau',
      'Thandiwe Nkosi',
      'Aïssatou Diallo',
      'Tunde Bakare',
      'Efua Owusu',
      'Sipho Dlamini',
      'Moussa Sy',
      'Kemi Adeyemi',
      'Amina Danjuma',
      'Ibrahim Salako',
      'Ngozi Abubakar',
      'Halima Chukwu',
      'Emeka Obi',
      'Funmilayo Garba',
    ];
    expect(new Set(names.map(avatarTone))).toEqual(new Set(AVATAR_TONES));
  });
});
