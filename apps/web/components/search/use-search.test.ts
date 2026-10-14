import { describe, expect, it } from 'vitest';
import { planSearch } from '../../lib/search-query';
import { panelState } from './use-search';

const NETWORK = { ok: false as const, error: { code: 'network' as const } };

describe('panelState: four states kept apart, and only the current answer drawn (R10, R16)', () => {
  it('draws nothing for nothing typed or too little, and the hint for a number being typed', () => {
    expect(panelState(planSearch(''), null)).toEqual({ kind: 'idle' });
    expect(panelState(planSearch('s'), null)).toEqual({ kind: 'idle' });
    expect(panelState(planSearch('0803'), null)).toEqual({ kind: 'keepTyping' });
  });

  it('is loading until the answer to the text in the box arrives, and ignores a stale one', () => {
    const plan = planSearch('samp');
    expect(panelState(plan, null)).toEqual({ kind: 'loading' });
    expect(panelState(plan, { key: 'q:sam', result: { ok: true, value: [] } })).toEqual({ kind: 'loading' });
    expect(panelState(plan, { key: 'q:sam', result: NETWORK })).toEqual({ kind: 'loading' });
    expect(panelState(plan, { key: 'q:samp', result: { ok: true, value: [] } })).toEqual({ kind: 'results', groups: [], q: 'samp' });
  });

  it('draws a lookup’s invalid_phone or invalid_email as a refusal, and anything else as a failure', () => {
    const phone = planSearch('0803 000');
    const refused = { ok: false as const, error: { code: 'validation_failed' as const, details: [{ path: 'phone', code: 'invalid_phone' }] } };
    expect(panelState(phone, { key: 'phone:0803 000', result: refused })).toEqual({ kind: 'invalid', field: 'phone' });
    expect(panelState(phone, { key: 'phone:0803 000', result: NETWORK })).toMatchObject({ kind: 'error' });
    const email = planSearch('a@');
    const badEmail = { ok: false as const, error: { code: 'validation_failed' as const, details: [{ path: 'email', code: 'invalid_email' }] } };
    expect(panelState(email, { key: 'email:a@', result: badEmail })).toEqual({ kind: 'invalid', field: 'email' });
  });

  it('a lookup answer carries no q, so it offers no "see all"', () => {
    const plan = planSearch('0803 000 0001');
    expect(panelState(plan, { key: 'phone:0803 000 0001', result: { ok: true, value: [] } })).toEqual({ kind: 'results', groups: [], q: null });
  });
});
