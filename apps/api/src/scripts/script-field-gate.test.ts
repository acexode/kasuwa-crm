import {
  WITHHOLDABLE_CONTACT_FIELDS,
  type ContactFieldAccess,
  type ContactFieldLevel,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { displayNameFact, fieldGate } from './script-field-gate';
import { publishProblems, type PublishContext, type ScriptContactField } from './script-publish';
import { ScriptGraphSchema, type StoredGraph } from './script-graph';

const P1 = '11111111-0000-4000-8000-0000001240b1';
const LIVE = '01130000-0000-4000-8000-0000000d0001';
const plain: ScriptContactField = { sensitive: false, withheld: false };

/** Part facts as contactFieldFacts builds them: every withholdable field plain, except `overrides`. */
function partFacts(overrides: Record<string, Partial<ScriptContactField>> = {}) {
  const facts = new Map<string, ScriptContactField>(
    WITHHOLDABLE_CONTACT_FIELDS.map((field) => [field, { ...plain, ...overrides[field] }]),
  );
  facts.set('displayName', displayNameFact(facts));
  return facts;
}

const access = (levels: Partial<Record<string, ContactFieldLevel>> = {}): ContactFieldAccess =>
  new Map([
    [
      P1,
      new Map(WITHHOLDABLE_CONTACT_FIELDS.map((field) => [field, levels[field] ?? 'edit'] as const)),
    ],
  ]);

describe('the displayName fact is derived from its parts (D-L68, D-L184)', () => {
  it('is sensitive when any part is sensitive, withheld when any part is withheld', () => {
    expect(displayNameFact(partFacts())).toEqual({ sensitive: false, withheld: false, standIn: true });
    for (const part of ['givenNames', 'familyName']) {
      expect(displayNameFact(partFacts({ [part]: { sensitive: true } })).sensitive, part).toBe(true);
      expect(displayNameFact(partFacts({ [part]: { withheld: true } })).withheld, part).toBe(true);
    }
    // Another field's classification changes nothing.
    expect(displayNameFact(partFacts({ phones: { sensitive: true } })).sensitive).toBe(false);
  });

  it('fails closed on a part with no fact: sensitive and withheld', () => {
    expect(displayNameFact(new Map())).toEqual({ sensitive: true, withheld: true, standIn: true });
  });
});

describe('at run, a displayName with a sensitive part follows the sensitive rule (D-L184)', () => {
  it('a branch reading it is sensitive, before withheld, even for a reader of both parts', () => {
    const sensitive = partFacts({ familyName: { sensitive: true } });
    expect(fieldGate('displayName', sensitive, access(), P1)).toEqual({ kind: 'sensitive' });
    expect(fieldGate('familyName', sensitive, access(), P1)).toEqual({ kind: 'sensitive' });
    expect(fieldGate('displayName', sensitive, access({ familyName: 'none' }), P1)).toEqual({
      kind: 'sensitive',
    });
  });

  it('otherwise: withheld when a part is withheld from the agent, readable when both are', () => {
    expect(fieldGate('displayName', partFacts(), access(), P1)).toBeNull();
    expect(fieldGate('displayName', partFacts(), access({ givenNames: 'none' }), P1)).toEqual({
      kind: 'withheld',
    });
    expect(fieldGate('displayName', partFacts(), access({ familyName: 'read' }), P1)).toBeNull();
    expect(fieldGate('nonsense', partFacts(), access(), P1)).toEqual({ kind: 'withheld' });
  });
});

describe('at publish, a displayName with a sensitive part is refused like the part (D-L184)', () => {
  const graph = (kind: 'variable' | 'branch'): StoredGraph =>
    ScriptGraphSchema.parse({
      startNodeId: 'greet',
      nodes: [
        {
          id: 'greet',
          type: 'say',
          title: 'Greeting',
          text: kind === 'variable' ? 'Hello {contact.displayName}.' : 'Hello.',
          next: 'b',
        },
        {
          id: 'b',
          type: 'branch',
          title: 'Named?',
          condition: {
            source: 'contact_field',
            field: kind === 'branch' ? 'displayName' : 'status',
            operator: 'is_set',
          },
          whenTrue: 'end',
          whenFalse: 'end',
        },
        { id: 'end', type: 'end', title: 'End', suggestedDispositionId: LIVE },
      ],
    }) as StoredGraph;
  const context = (facts: Map<string, ScriptContactField>): PublishContext => ({
    contactFields: facts,
    liveDispositionIds: new Set([LIVE]),
  });
  const codes = (kind: 'variable' | 'branch', facts: Map<string, ScriptContactField>) =>
    publishProblems(graph(kind), {}, context(facts)).map((detail) => detail.code);

  it('a variable and a branch are both sensitive_field; a withheld-only name lets the variable through', () => {
    const sensitive = partFacts({ givenNames: { sensitive: true } });
    expect(codes('variable', sensitive)).toContain('sensitive_field');
    expect(codes('branch', sensitive)).toContain('sensitive_field');
    const withheld = partFacts({ familyName: { withheld: true } });
    expect(codes('variable', withheld)).toEqual([]);
    expect(codes('branch', withheld)).toEqual(['branch_on_withheld_field']);
    expect(codes('variable', partFacts())).toEqual([]);
  });
});
