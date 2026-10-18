import type { CustomFieldAccess, CustomFieldDef } from '@kasuwa/metadata-engine';
import { describe, expect, it } from 'vitest';
import { WITHHOLDABLE_CONTACT_FIELDS, type ContactFieldAccess, type ContactFieldLevel } from '../contact/contact-fields';
import type { ImportColumnMapping } from './import-job.repository';
import { parseImportRow, type ImportRowContext } from './import-rows';

const P = '11111111-0000-4000-8000-0000000000a1';
const OWNER = '11111111-0000-4000-8000-0000000000b1';

function access(overrides: Partial<Record<string, ContactFieldLevel>> = {}): ContactFieldAccess {
  const levels = new Map(WITHHOLDABLE_CONTACT_FIELDS.map((f) => [f, overrides[f] ?? 'edit'] as const));
  return new Map([[P, levels]]);
}

const tier: CustomFieldDef = {
  id: 'f1',
  apiName: 'tier__c',
  type: 'picklist',
  classification: 'none',
  values: ['gold', 'silver'],
  currencyCode: null,
};
const vip: CustomFieldDef = { ...tier, id: 'f2', apiName: 'vip__c', type: 'boolean', values: [] };

function custom(levels: Record<string, ContactFieldLevel> = {}): CustomFieldAccess {
  return {
    object: 'contact',
    defs: new Map([
      ['tier__c', tier],
      ['vip__c', vip],
    ]),
    access: new Map([[P, new Map(Object.entries({ tier__c: 'edit', vip__c: 'edit', ...levels }))]]),
    retired: [],
  };
}

function context(columns: ImportColumnMapping[], options: Partial<ImportRowContext> = {}): ImportRowContext {
  return {
    mapping: { columns, defaultCountry: 'NG', ownerUserId: null },
    programmeId: P,
    contactAccess: access(),
    custom: custom(),
    ...options,
  };
}

const col = (index: number, field: string | null): ImportColumnMapping => ({ index, field });

describe('parseImportRow', () => {
  it('builds a new contact: E.164 phones, source import by default, no grant', () => {
    const parsed = parseImportRow(
      ['Ada', '0803 555 0101', 'Ada@Example.test', 'new'],
      context([col(0, 'displayName'), col(1, 'phones'), col(2, 'emails'), col(3, 'status')]),
    );
    expect(parsed).toEqual({
      ok: true,
      values: {
        displayName: 'Ada',
        phones: [{ type: 'mobile', e164: '+2348035550101' }],
        emails: ['Ada@Example.test'],
        status: 'new',
        source: 'import',
      },
      custom: {},
      dnd: false,
    });
  });

  it('normalises each market with its trunk 0, and keeps a + number in its own country (R16)', () => {
    const cases: [string, string, string][] = [
      ['GH', '024 455 0103', '+233244550103'],
      ['KE', '0712 555 104', '+254712555104'],
      ['ZA', '082 555 0105', '+27825550105'],
      ['ZA', '+234-803-555-0195', '+2348035550195'],
    ];
    for (const [country, typed, e164] of cases) {
      const ctx = context([col(0, 'displayName'), col(1, 'phones')]);
      const parsed = parseImportRow(['x', typed], { ...ctx, mapping: { ...ctx.mapping, defaultCountry: country as 'NG' } });
      expect(parsed.ok && parsed.values.phones, `${country} ${typed}`).toEqual([{ type: 'mobile', e164 }]);
    }
  });

  it('reports {column, code} and never a value', () => {
    const ctx = context([col(0, 'displayName'), col(1, 'phones'), col(2, 'emails'), col(3, 'status')]);
    expect(parseImportRow(['x'.repeat(201), '', '', ''], ctx)).toEqual({ ok: false, errors: [{ column: 0, code: 'too_long' }] });
    expect(parseImportRow(['', '', '', ''], ctx)).toEqual({ ok: false, errors: [{ column: 0, code: 'required' }] });
    expect(parseImportRow(['a', 'call me', '', ''], ctx)).toEqual({ ok: false, errors: [{ column: 1, code: 'invalid_phone' }] });
    expect(parseImportRow(['a', '', 'nope', ''], ctx)).toEqual({ ok: false, errors: [{ column: 2, code: 'invalid_email' }] });
    expect(parseImportRow(['a', '', '', 'banana'], ctx)).toEqual({ ok: false, errors: [{ column: 3, code: 'unknown_value' }] });
  });

  it('compliance is restrict-or-default: no spelling of a grant is ever accepted (D-P28, R8)', () => {
    const ctx = context([col(0, 'displayName'), col(1, 'dnd'), col(2, 'whatsappOptIn'), col(3, 'consentState')]);
    const ok = parseImportRow(['a', 'true', 'false', 'withdrawn'], ctx);
    expect(ok).toMatchObject({ ok: true, dnd: true, values: { whatsappOptIn: false, consentState: 'withdrawn' } });
    expect(parseImportRow(['a', '', 'true', ''], ctx)).toEqual({ ok: false, errors: [{ column: 2, code: 'consent_grant_refused' }] });
    expect(parseImportRow(['a', '', '', 'opted_in'], ctx)).toEqual({ ok: false, errors: [{ column: 3, code: 'consent_grant_refused' }] });
    expect(parseImportRow(['a', '', '', 'pending'], ctx)).toEqual({ ok: false, errors: [{ column: 3, code: 'consent_grant_refused' }] });
    for (const spelling of ['TRUE', 'yes', '1', 'on', 'Y']) {
      const parsed = parseImportRow(['a', '', spelling, ''], ctx);
      expect(parsed.ok, spelling).toBe(false);
    }
    for (const spelling of ['OPTED_IN', 'opted-in', 'Pending', 'optedin']) {
      const parsed = parseImportRow(['a', '', '', spelling], ctx);
      expect(parsed.ok, spelling).toBe(false);
    }
  });

  it('custom fields use the live definitions: unknown picklist value, boolean spellings', () => {
    const ctx = context([col(0, 'displayName'), col(1, 'custom.tier__c'), col(2, 'custom.vip__c')]);
    expect(parseImportRow(['a', 'gold', 'true'], ctx)).toMatchObject({ ok: true, custom: { tier__c: 'gold', vip__c: true } });
    expect(parseImportRow(['a', 'platinum', ''], ctx)).toEqual({ ok: false, errors: [{ column: 1, code: 'unknown_value' }] });
    expect(parseImportRow(['a', '', 'yes'], ctx)).toEqual({ ok: false, errors: [{ column: 2, code: 'invalid_value' }] });
  });

  it('field security is judged per row: a non-editable field with a value is field_not_editable (R12)', () => {
    const ctx = context([col(0, 'displayName'), col(1, 'emails'), col(2, 'custom.tier__c')], {
      contactAccess: access({ emails: 'read' }),
      custom: custom({ tier__c: 'read' }),
    });
    expect(parseImportRow(['a', '', ''], ctx)).toMatchObject({ ok: true });
    expect(parseImportRow(['a', 'a@example.test', 'gold'], ctx)).toEqual({
      ok: false,
      errors: [
        { column: 1, code: 'field_not_editable' },
        { column: 2, code: 'field_not_editable' },
      ],
    });
  });

  it('derives displayName from given and family names only when displayName is not mapped', () => {
    const derived = parseImportRow(['Ada', 'Obi'], context([col(0, 'givenNames'), col(1, 'familyName')]));
    expect(derived).toMatchObject({ ok: true, values: { displayName: 'Ada Obi' } });
    const mapped = parseImportRow(['', 'Ada'], context([col(0, 'displayName'), col(1, 'givenNames')]));
    expect(mapped).toEqual({ ok: false, errors: [{ column: 0, code: 'required' }] });
  });

  it('a NUL in any mapped cell is that row\'s invalid_value, tags included (D-L167 N6)', () => {
    const ctx = context([col(0, 'displayName'), col(1, 'tags'), col(2, 'state')]);
    expect(parseImportRow(['a', 'vip\u0000', ''], ctx)).toEqual({ ok: false, errors: [{ column: 1, code: 'invalid_value' }] });
    expect(parseImportRow(['a', '', 'La\u0000gos'], ctx)).toEqual({ ok: false, errors: [{ column: 2, code: 'invalid_value' }] });
    expect(parseImportRow(['a\u0000', '', ''], ctx)).toEqual({ ok: false, errors: [{ column: 0, code: 'invalid_value' }] });
  });

  it('sets the mapping owner on every row', () => {
    const ctx = context([col(0, 'displayName')]);
    const parsed = parseImportRow(['a'], { ...ctx, mapping: { ...ctx.mapping, ownerUserId: OWNER } });
    expect(parsed).toMatchObject({ ok: true, values: { ownerUserId: OWNER } });
  });
});
