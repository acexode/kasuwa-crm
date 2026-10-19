import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT_GRAPH,
  ScriptGraphSchema,
  type StoredGraph,
  type Translations,
} from './script-graph';
import {
  complianceDiff,
  publishProblems,
  suggestedDispositionIds,
  variablesIn,
  type PublishContext,
  type ScriptContactField,
} from './script-publish';

const LIVE = '01130000-0000-4000-8000-0000000d0001';

function parse(input: unknown): StoredGraph {
  return ScriptGraphSchema.parse(input) as StoredGraph;
}

function good(): StoredGraph {
  return parse({
    startNodeId: 'greet',
    nodes: [
      {
        id: 'greet',
        type: 'say',
        title: 'Greeting',
        text: 'Hello {contact.displayName}, I am {agent.displayName}.',
        next: 'rec',
      },
      { id: 'rec', type: 'compliance', title: 'Recorded', text: 'Recorded.', next: 'ask' },
      {
        id: 'ask',
        type: 'question',
        title: 'Pay?',
        text: 'Can you pay?',
        choices: [
          { key: 'yes', label: 'Yes', next: 'ptp' },
          { key: 'no', label: 'No', next: 'cust' },
        ],
      },
      {
        id: 'ptp',
        type: 'form',
        title: 'Promise',
        text: 'Agree it.',
        fields: [
          {
            key: 'amount',
            label: 'Amount',
            type: 'money',
            required: true,
            currency: 'NGN',
            minimumMinor: '1',
            maximumMinor: '9',
          },
        ],
        next: 'readback',
      },
      {
        id: 'readback',
        type: 'compliance',
        title: 'Read back',
        text: 'You pay {answer.ptp.amount}.',
        next: 'close',
      },
      {
        id: 'cust',
        type: 'branch',
        title: 'Customer?',
        condition: { source: 'contact_field', field: 'status', operator: 'is_set' },
        whenTrue: 'close',
        whenFalse: 'close',
      },
      { id: 'close', type: 'end', title: 'Close', suggestedDispositionId: LIVE },
    ],
  });
}

function context(fields: Record<string, Partial<ScriptContactField>> = {}): PublishContext {
  const base: Record<string, ScriptContactField> = {
    displayName: { sensitive: false, withheld: false },
    status: { sensitive: false, withheld: false },
    givenNames: { sensitive: false, withheld: false },
    lga: { sensitive: false, withheld: false },
  };
  for (const [name, flags] of Object.entries(fields)) {
    base[name] = { ...(base[name] ?? { sensitive: false, withheld: false }), ...flags };
  }
  return { contactFields: new Map(Object.entries(base)), liveDispositionIds: new Set([LIVE]) };
}

const codesAt = (details: { path: string; code: string }[], path: string) =>
  details.filter((detail) => detail.path === path).map((detail) => detail.code);

/** `good()` with one node replaced. */
function withNode(id: string, change: (node: Record<string, unknown>) => Record<string, unknown>) {
  const graph = good();
  return parse({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === id ? change(node as unknown as Record<string, unknown>) : node,
    ),
  });
}

describe('publishProblems (T-0113, D-L93)', () => {
  it('publishes the complete graph', () => {
    expect(publishProblems(good(), {}, context())).toEqual([]);
  });

  it('missing_start', () => {
    expect(publishProblems({ ...good(), startNodeId: 'nowhere' }, {}, context())).toContainEqual({
      path: 'startNodeId',
      code: 'missing_start',
    });
  });

  it('empty_script: the empty draft, and any graph of end nodes only, is never published', () => {
    expect(publishProblems(EMPTY_DRAFT_GRAPH, {}, context())).toEqual([
      { path: 'nodes', code: 'empty_script' },
    ]);
    const twoEnds = parse({
      startNodeId: 'a',
      nodes: [
        { id: 'a', type: 'end', title: 'A' },
        { id: 'b', type: 'end', title: 'B' },
      ],
    });
    expect(codesAt(publishProblems(twoEnds, {}, context()), 'nodes')).toEqual(['empty_script']);
  });

  it('unknown_target at the contract’s id-based paths', () => {
    const details = publishProblems(
      withNode('ask', (node) => ({
        ...node,
        choices: [
          { key: 'yes', label: 'Yes', next: 'ptp' },
          { key: 'no', label: 'No', next: 'ghost' },
        ],
      })),
      {},
      context(),
    );
    expect(codesAt(details, 'nodes.ask.choices.no.next')).toContain('unknown_target');
    const branch = publishProblems(
      withNode('cust', (node) => ({ ...node, whenFalse: 'ghost' })),
      {},
      context(),
    );
    expect(codesAt(branch, 'nodes.cust.whenFalse')).toContain('unknown_target');
  });

  it('cycle, unreachable_end and an unreachable node, each named by node', () => {
    const cycle = publishProblems(
      withNode('readback', (node) => ({ ...node, next: 'greet' })),
      {},
      context(),
    );
    expect(codesAt(cycle, 'nodes.greet')).toContain('cycle');

    const loop = good();
    const trapped = parse({
      ...loop,
      nodes: [
        ...loop.nodes.map((node) => (node.id === 'rec' ? { ...node, next: 'loopa' } : node)),
        { id: 'loopa', type: 'say', title: 'A', text: 'A', next: 'loopb' },
        { id: 'loopb', type: 'say', title: 'B', text: 'B', next: 'loopa' },
      ],
    });
    const details = publishProblems(trapped, {}, context());
    expect(codesAt(details, 'nodes.loopa')).toContain('unreachable_end');
    expect(codesAt(details, 'nodes.loopb')).toContain('unreachable_end');

    const orphaned = parse({
      ...loop,
      nodes: [...loop.nodes, { id: 'orphan', type: 'end', title: 'Never reached' }],
    });
    expect(codesAt(publishProblems(orphaned, {}, context()), 'nodes.orphan')).toContain(
      'unreachable_node',
    );
  });

  it('is linear: 26 diamonds (2^26 paths) in well under a second', () => {
    const nodes: unknown[] = [];
    for (let index = 0; index < 26; index += 1) {
      const join = index + 1 < 26 ? `q${index + 1}` : 'fin';
      nodes.push({
        id: `q${index}`,
        type: 'question',
        title: 'Fork',
        text: 'Left or right?',
        choices: [
          { key: 'left', label: 'Left', next: `l${index}` },
          { key: 'right', label: 'Right', next: `r${index}` },
        ],
      });
      nodes.push({ id: `l${index}`, type: 'say', title: 'L', text: 'L', next: join });
      nodes.push({ id: `r${index}`, type: 'say', title: 'R', text: 'R', next: join });
    }
    nodes.push({ id: 'fin', type: 'end', title: 'End' });
    const started = Date.now();
    expect(publishProblems(parse({ startNodeId: 'q0', nodes }), {}, context())).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each(['favouriteColour', 'constructor', 'toString', 'hasOwnProperty', 'tenantId'])(
    'unknown_field for a branch on %s',
    (field) => {
      const graph = withNode('cust', (node) => ({
        ...node,
        condition: { source: 'contact_field', field, operator: 'is_set' },
      }));
      expect(codesAt(publishProblems(graph, {}, context()), 'nodes.cust.condition.field')).toEqual(
        ['unknown_field'],
      );
    },
  );

  it('unknown_variable for anything but the three variable kinds, in source and translation', () => {
    for (const variable of ['{loan.balance}', '{agent.email}', '{contact.constructor}', '{answer.ptp.ghost}']) {
      const graph = withNode('greet', (node) => ({ ...node, text: `Hi ${variable}` }));
      expect(codesAt(publishProblems(graph, {}, context()), 'nodes.greet.text'), variable).toEqual([
        'unknown_variable',
      ]);
    }
    const translations: Translations = { pcm: { greet: { text: 'Abeg {loan.balance}' } } };
    expect(
      codesAt(publishProblems(good(), translations, context()), 'translations.pcm.greet.text'),
    ).toEqual(['unknown_variable']);
  });

  it('sensitive_field and branch_on_withheld_field on branches, variables and translations', () => {
    const sensitive = context({ status: { sensitive: true }, lga: { sensitive: true } });
    expect(codesAt(publishProblems(good(), {}, sensitive), 'nodes.cust.condition.field')).toEqual([
      'sensitive_field',
    ]);
    const translated: Translations = { yo: { greet: { text: 'E kaasan {contact.lga}' } } };
    expect(
      codesAt(publishProblems(good(), translated, sensitive), 'translations.yo.greet.text'),
    ).toEqual(['sensitive_field']);

    const withheld = context({ givenNames: { withheld: true } });
    const graph = withNode('greet', (node) => ({ ...node, text: 'Hi {contact.givenNames}' }));
    expect(codesAt(publishProblems(graph, {}, withheld), 'nodes.greet.text')).toEqual([
      'branch_on_withheld_field',
    ]);
  });

  it('a withheld displayName is displayed as a stand-in, so a variable publishes; a branch on it is refused (D-L180, T-0124 I13)', () => {
    const withheld = context({ displayName: { withheld: true, standIn: true } });
    // The greeting variable in good() publishes.
    expect(codesAt(publishProblems(good(), {}, withheld), 'nodes.greet.text')).toEqual([]);
    const translated: Translations = { ha: { greet: { text: 'Sannu {contact.displayName}' } } };
    expect(
      codesAt(publishProblems(good(), translated, withheld), 'translations.ha.greet.text'),
    ).toEqual([]);
    const branch = withNode('cust', (node) => ({
      ...node,
      condition: { source: 'contact_field', field: 'displayName', operator: 'is_set' },
    }));
    expect(codesAt(publishProblems(branch, {}, withheld), 'nodes.cust.condition.field')).toEqual([
      'branch_on_withheld_field',
    ]);
    expect(codesAt(publishProblems(branch, {}, context()), 'nodes.cust.condition.field')).toEqual(
      [],
    );
    // standIn is displayName's alone: any other withheld variable is still refused.
    const other = context({ givenNames: { withheld: true } });
    const graph = withNode('greet', (node) => ({ ...node, text: 'Hi {contact.givenNames}' }));
    expect(codesAt(publishProblems(graph, {}, other), 'nodes.greet.text')).toEqual([
      'branch_on_withheld_field',
    ]);
  });

  it('disposition_not_live: one code for anything but a live disposition', () => {
    const graph = withNode('close', (node) => ({
      ...node,
      suggestedDispositionId: '01130000-0000-4000-8000-0000000d0009',
    }));
    expect(
      codesAt(publishProblems(graph, {}, context()), 'nodes.close.suggestedDispositionId'),
    ).toEqual(['disposition_not_live']);
    expect(suggestedDispositionIds(good())).toEqual([LIVE]);
  });

  it('a translation of a node the draft no longer has is refused', () => {
    const translations: Translations = { ha: { gone: { text: 'x' } } };
    expect(codesAt(publishProblems(good(), translations, context()), 'translations.ha.gone')).toEqual(
      ['unknown_node'],
    );
  });

  it('names paths and codes only, never wording', () => {
    const graph = withNode('greet', (node) => ({ ...node, text: 'SECRET {loan.balance}' }));
    expect(JSON.stringify(publishProblems(graph, {}, context()))).not.toContain('SECRET');
  });
});

describe('variablesIn', () => {
  it('reads every braced token', () => {
    expect(variablesIn('{a.b} and {c} but not { unbalanced')).toEqual(['a.b', 'c']);
  });
});

describe('complianceDiff (R3)', () => {
  it('names added, removed and changed compliance nodes, and leaves unchanged ones out', () => {
    const before = good();
    const after = parse({
      ...before,
      nodes: [
        ...before.nodes
          .filter((node) => node.id !== 'rec')
          .map((node) =>
            node.id === 'readback' ? { ...node, text: 'You will pay {answer.ptp.amount}.' } : node,
          ),
        { id: 'fresh', type: 'compliance', title: 'New', text: 'New.', next: 'close' },
      ],
    });
    expect(
      complianceDiff({ graph: before, translations: {} }, { graph: after, translations: {} }),
    ).toEqual({ added: ['fresh'], removed: ['rec'], changed: ['readback'] });
  });

  it('a translated wording change is a change; key order is not', () => {
    const graph = good();
    expect(
      complianceDiff(
        { graph, translations: { ha: { rec: { title: 'A', text: 'B' } } } },
        { graph, translations: { ha: { rec: { text: 'B', title: 'A' } } } },
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
    expect(
      complianceDiff(
        { graph, translations: {} },
        { graph, translations: { ha: { rec: { text: 'An nadi' } } } },
      ).changed,
    ).toEqual(['rec']);
  });

  it('the first publish adds every compliance node', () => {
    expect(complianceDiff(null, { graph: good(), translations: {} }).added).toEqual([
      'readback',
      'rec',
    ]);
  });
});
