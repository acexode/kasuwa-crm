import { describe, expect, it } from 'vitest';
import type { ContactMerge, ContactMergePreview, PreviewContact } from '../../lib/duplicates-api';
import { COMPLIANCE_FIELDS, MERGE_FIELDS } from '../../lib/duplicates-api';
import { mergeRefusal, undoRefusal } from './duplicates-model';
import { DRAWN_FIELDS, complianceLabel, complianceRows, fieldValue, findOwnMerge, mergeBody, mergeReducer, rowsOf, startMerge, type MergeAction, type MergeView } from './merge-model';

const A = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const B = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02';
const C = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03';

function contact(id: string, version: number, extra: Partial<PreviewContact> = {}): PreviewContact {
  return {
    id,
    programmeId: 'p1',
    version,
    displayName: 'Sample Fixture',
    status: 'contacted',
    emails: [],
    tags: [],
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-10T09:00:00Z',
    withheldFields: [],
    ...extra,
  };
}

function preview(overrides: Partial<ContactMergePreview> = {}): ContactMergePreview {
  return {
    survivor: contact(A, 3, { emails: ['sample@example.test'] }),
    merged: contact(B, 1, { status: 'qualified', companyName: 'Sample Fabrics' }),
    defaults: { status: 'merged', companyName: 'merged', emails: 'survivor', source: 'survivor' },
    compliance: { dnd: true, whatsappOptIn: false, consentState: 'withdrawn', withheldFields: [] },
    ...overrides,
  };
}

function merge(extra: Partial<ContactMerge> = {}): ContactMerge {
  return {
    id: '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a01',
    programmeId: 'p1',
    survivor: { id: A, displayName: 'Sample Fixture' },
    merged: { id: B, displayName: null },
    mergedByUserId: 'u1',
    mergedAt: '2026-10-18T09:00:00Z',
    undoUntil: '2026-11-17T09:00:00Z',
    undoneAt: null,
    undoneByUserId: null,
    survivorReverted: null,
    ...extra,
  };
}

function run(view: MergeView, ...actions: MergeAction[]): MergeView {
  return actions.reduce(mergeReducer, view);
}

describe('the comparison’s rows (I5, I6)', () => {
  it('draws a choice for each field the API offers, preset to its default, and a pick over it', () => {
    const rows = rowsOf(preview(), {}, []);
    expect(rows.find((row) => row.field === 'status')).toEqual({ field: 'status', kind: 'choice', pick: 'merged' });
    expect(rows.find((row) => row.field === 'emails')).toEqual({ field: 'emails', kind: 'choice', pick: 'survivor' });
    expect(rowsOf(preview(), { status: 'survivor' }, []).find((row) => row.field === 'status')?.pick).toBe('survivor');
  });

  it('draws a field either side withholds as withheld, whatever the defaults say', () => {
    const withheld = preview({ merged: contact(B, 1, { withheldFields: ['emails'] }) });
    expect(rowsOf(withheld, {}, []).find((row) => row.field === 'emails')).toEqual({ field: 'emails', kind: 'withheld', pick: null });
    const other = preview({ survivor: contact(A, 3, { withheldFields: ['status'] }) });
    expect(rowsOf(other, {}, []).find((row) => row.field === 'status')?.kind).toBe('withheld');
  });

  it('locks a readable field the API did not offer, and one it refused since', () => {
    const rows = rowsOf(preview(), {}, ['status']);
    expect(rows.find((row) => row.field === 'tags')?.kind).toBe('locked');
    expect(rows.find((row) => row.field === 'status')).toEqual({ field: 'status', kind: 'locked', pick: null });
  });

  it('never draws the owner or the account, which are ids with no name (D-L64), nor a compliance field', () => {
    const fields = rowsOf(preview(), {}, []).map((row) => row.field);
    expect(fields).toEqual([...DRAWN_FIELDS]);
    expect(fields).not.toContain('ownerUserId');
    expect(fields).not.toContain('accountId');
    for (const field of COMPLIANCE_FIELDS) expect(MERGE_FIELDS as readonly string[]).not.toContain(field);
  });

  it('draws values as record text, labels of ours, or nothing — never an id', () => {
    expect(fieldValue(contact(A, 1, { emails: ['a@example.test', 'b@example.test'] }), 'emails')).toEqual({ kind: 'text', parts: ['a@example.test', 'b@example.test'] });
    expect(fieldValue(contact(A, 1, { phones: [{ type: 'mobile', e164: '+2348030000001' }] }), 'phones')).toEqual({ kind: 'text', parts: ['+2348030000001'] });
    expect(fieldValue(contact(A, 1), 'tags')).toEqual({ kind: 'empty' });
    expect(fieldValue(contact(A, 1), 'status')).toEqual({ kind: 'label', id: 'records.status.contacted' });
    expect(fieldValue(contact(A, 1, { companyName: '  ' }), 'companyName')).toEqual({ kind: 'empty' });
  });

  it('shows the compliance outcome the API computed, as a word, and a withheld one as withheld', () => {
    const rows = complianceRows(preview());
    expect(rows.map((row) => [row.field, row.value])).toEqual([['dnd', 'true'], ['whatsappOptIn', 'false'], ['consentState', 'withdrawn']]);
    expect(rows.map(complianceLabel)).toEqual(['records.dnd.label', 'records.wa.out', 'records.consent.withdrawn']);
    const hidden = complianceRows(preview({ compliance: { dnd: true, withheldFields: ['consentState'] } }));
    expect(hidden.find((row) => row.field === 'consentState')).toEqual({ field: 'consentState', withheld: true, value: null });
    expect(hidden.find((row) => row.field === 'whatsappOptIn')?.withheld).toBe(true);
  });
});

describe('what the merge sends (I7)', () => {
  it('carries the preview’s ids and versions, and a choice per drawn choice, so what is shown is what is sent', () => {
    const body = mergeBody(preview(), { status: 'survivor' }, []);
    expect(body).toEqual({
      survivorId: A,
      mergedId: B,
      survivorVersion: 3,
      mergedVersion: 1,
      choices: { status: 'survivor', companyName: 'merged', emails: 'survivor', source: 'survivor' },
    });
  });

  it('never names a withheld field, a read-only field, a compliance field or one the API refused', () => {
    const withheld = preview({ survivor: contact(A, 3, { withheldFields: ['emails'] }) });
    const choices = Object.keys(mergeBody(withheld, {}, ['status']).choices);
    expect(choices).toEqual(['companyName', 'source']);
    for (const field of [...COMPLIANCE_FIELDS, 'emails', 'status', 'tags', 'ownerUserId']) expect(choices).not.toContain(field);
  });

  it('does not send the choices of a default it does not draw', () => {
    // A custom field or the owner is in `defaults` but has no row: the API applies its own default.
    const odd = preview({ defaults: { status: 'merged', ownerUserId: 'merged', 'custom.region__c': 'survivor' } });
    expect(Object.keys(mergeBody(odd, {}, []).choices)).toEqual(['status']);
  });
});

describe('the merge view’s state (I5, I7–I10)', () => {
  const loaded = (extra: Partial<MergeView> = {}): MergeView => ({ ...run(startMerge([A, B]), { type: 'loaded', preview: preview() }), ...extra });

  it('starts loading with the first of the pair as the main record, and remembers the names it is served', () => {
    const start = startMerge([A, B]);
    expect(start).toMatchObject({ mainId: A, otherId: B, load: 'loading', preview: null, step: 'compare', undoable: true, dirty: false });
    expect(loaded().names).toEqual({ [A]: 'Sample Fixture', [B]: 'Sample Fixture' });
    expect(loaded().load).toBe('ready');
  });

  it('swaps the main record, drops the picks and reads the preview the other way round', () => {
    const picked = run(loaded(), { type: 'pick', field: 'status', side: 'survivor' });
    expect(picked.overrides).toEqual({ status: 'survivor' });
    const swapped = run(picked, { type: 'main', id: B });
    expect(swapped).toMatchObject({ mainId: B, otherId: A, load: 'loading', preview: null, overrides: {} });
    expect(swapped.pair).toEqual([A, B]);
    // Choosing the main record that already is, or a stranger, changes nothing.
    expect(run(loaded(), { type: 'main', id: A })).toEqual(loaded());
    expect(run(loaded(), { type: 'main', id: C })).toEqual(loaded());
  });

  it('keeps a pick across a re-read only for a field that is still a choice', () => {
    const picked = run(loaded(), { type: 'pick', field: 'status', side: 'survivor' }, { type: 'pick', field: 'source', side: 'merged' });
    const reread = run(picked, { type: 'reread' }, { type: 'loaded', preview: preview({ defaults: { status: 'merged' } }) });
    expect(reread.overrides).toEqual({ status: 'survivor' });
  });

  it('takes no pick, and no swap, once the merge is on its way', () => {
    const sending = run(loaded(), { type: 'merging' });
    expect(run(sending, { type: 'pick', field: 'status', side: 'survivor' }).overrides).toEqual({});
    expect(run(sending, { type: 'main', id: B }).mainId).toBe(A);
  });

  it('shows a merge as done, undoable, and marks the sets and the history to be read again', () => {
    const done = run(loaded(), { type: 'merging' }, { type: 'merged', merge: merge() });
    expect(done).toMatchObject({ step: 'done', undoable: true, expired: false, dirty: true });
    expect(done.merge?.survivor.id).toBe(A);
  });

  it('locks a refused field for good, drops its pick, and goes back to the comparison (I9)', () => {
    const picked = run(loaded(), { type: 'pick', field: 'status', side: 'survivor' }, { type: 'merging' });
    const refused = run(picked, { type: 'mergeFailed', refusal: mergeRefusal({ code: 'not_permitted', details: [{ path: 'choices.status', code: 'field_not_editable' }] }) });
    expect(refused).toMatchObject({ step: 'compare', refused: ['status'], overrides: {} });
    // The next preview does not bring it back as a choice, and the body never names it.
    const again = run(refused, { type: 'reread' }, { type: 'loaded', preview: preview() });
    expect(rowsOf(again.preview as ContactMergePreview, again.overrides, again.refused).find((row) => row.field === 'status')?.kind).toBe('locked');
    expect(Object.keys(mergeBody(again.preview as ContactMergePreview, again.overrides, again.refused).choices)).not.toContain('status');
  });

  it('reads the preview again after a stale write, and keeps the picks that still apply', () => {
    const picked = run(loaded(), { type: 'pick', field: 'status', side: 'survivor' }, { type: 'merging' });
    const stale = run(picked, { type: 'mergeFailed', refusal: mergeRefusal({ code: 'stale_write' }) });
    expect(stale).toMatchObject({ step: 'compare', load: 'loading', preview: null, overrides: { status: 'survivor' } });
    const fresh = preview({ survivor: contact(A, 4) });
    expect(run(stale, { type: 'loaded', preview: fresh }).preview?.survivor.version).toBe(4);
  });

  it('marks the sets to be read again when the pair was merged elsewhere', () => {
    const refused = run(loaded(), { type: 'merging' }, { type: 'mergeFailed', refusal: mergeRefusal({ code: 'already_merged' }) });
    expect(refused).toMatchObject({ step: 'compare', dirty: true });
  });

  it('leaves everything as it was for a refusal with no effect', () => {
    const before = loaded();
    const after = run(before, { type: 'merging' }, { type: 'mergeFailed', refusal: mergeRefusal({ code: 'not_permitted' }) });
    expect(after).toEqual(before);
  });

  it('draws an undo as undone, and a repeat of a refused one never offers it again (I10)', () => {
    const done = run(loaded(), { type: 'merging' }, { type: 'merged', merge: merge() });
    const undone = run(done, { type: 'undoing' }, { type: 'undone', merge: merge({ undoneAt: '2026-10-19T00:00:00Z', survivorReverted: false }) });
    expect(undone).toMatchObject({ step: 'undone', dirty: true });
    expect(undone.merge?.survivorReverted).toBe(false);

    const expired = run(done, { type: 'undoing' }, { type: 'undoFailed', refusal: undoRefusal({ code: 'undo_expired' }) });
    expect(expired).toMatchObject({ step: 'done', undoable: false, expired: true });
    const gone = run(done, { type: 'undoing' }, { type: 'undoFailed', refusal: undoRefusal({ code: 'not_found' }) });
    expect(gone).toMatchObject({ step: 'done', undoable: false, expired: false });
    const dropped = run(done, { type: 'undoing' }, { type: 'undoFailed', refusal: undoRefusal({ code: 'network' }) });
    expect(dropped).toMatchObject({ step: 'done', undoable: true });
  });

  it('keeps a failed preview from leaving a stale one on screen', () => {
    expect(run(loaded(), { type: 'reread' }, { type: 'loadFailed' })).toMatchObject({ load: 'failed', preview: null });
  });
});

describe('a merge whose answer was lost (B1)', () => {
  const sent: readonly [string, string] = [A, B];

  it('finds the person’s own open merge of the pair, in either orientation', () => {
    const own = merge();
    expect(findOwnMerge([own], sent)).toBe(own);
    const flipped = merge({ survivor: { id: B, displayName: null }, merged: { id: A, displayName: 'x' } });
    expect(findOwnMerge([flipped], sent)).toBe(flipped);
  });

  it('is not fooled by an undone merge, another pair or an empty history', () => {
    expect(findOwnMerge([merge({ undoneAt: '2026-10-19T00:00:00Z' })], sent)).toBeNull();
    expect(findOwnMerge([merge({ merged: { id: C, displayName: null } })], sent)).toBeNull();
    expect(findOwnMerge([], sent)).toBeNull();
  });

  it('shows the found merge as the result, with Undo, and unblocks Merge', () => {
    const lost = run(startMerge(sent), { type: 'loaded', preview: preview() }, { type: 'merging' }, { type: 'lost' });
    expect(lost).toMatchObject({ step: 'compare', blocked: true, dirty: true });
    const found = run(lost, { type: 'merged', merge: merge() });
    expect(found).toMatchObject({ step: 'done', undoable: true, blocked: false });
    expect(found.merge?.survivor.id).toBe(A);
  });
});
