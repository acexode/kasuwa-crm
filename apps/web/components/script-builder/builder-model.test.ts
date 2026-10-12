import { describe, expect, it } from 'vitest';
import { ScriptGraph, type ScriptNode } from '../../lib/script-graph';
import {
  BRANCH_FIELDS,
  NAME_CONFLICT,
  changedFields,
  changedLocales,
  complianceDiff,
  conditionForSource,
  insertToken,
  newNode,
  parseValue,
  publishProblems,
  rebase,
  retypeField,
  sameJson,
  translationBody,
  variablesFor,
  withOperator,
  type DraftState,
} from './builder-model';

const WORDS = { title: 'New step', text: 'Type it.', choice: 'Answer', field: 'New field', option: 'Option' };

const GRAPH: ScriptGraph = {
  startNodeId: 'greet',
  nodes: [
    { id: 'greet', type: 'say', title: 'Greeting', text: 'Hello {contact.displayName}', next: 'rec', position: { x: 40, y: 30 } },
    { id: 'rec', type: 'compliance', title: 'Recording notice', text: 'This call is recorded.', next: 'payq' },
    {
      id: 'payq',
      type: 'question',
      title: 'Can pay today?',
      text: 'Can you pay?',
      choices: [
        { key: 'yes', label: 'Yes', next: 'ptp' },
        { key: 'no', label: 'No', next: 'close' },
      ],
    },
    { id: 'ptp', type: 'form', title: 'Promise', text: 'When?', next: 'close', fields: [{ key: 'date', label: 'Date', type: 'date', required: true }] },
    { id: 'close', type: 'end', title: 'Close', text: null, suggestedDispositionId: null },
  ],
};

function draft(graph: ScriptGraph = GRAPH, name = 'Collections'): DraftState {
  return { name, graph };
}

function retitle(graph: ScriptGraph, id: string, title: string): ScriptGraph {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === id ? { ...node, title } : node)) };
}

describe('changed fields only (D-L102, R5)', () => {
  it('sends nothing when nothing changed, and never a field equal to what was served', () => {
    expect(changedFields(draft(), draft())).toEqual({});
    expect(changedFields(draft(GRAPH, 'Renamed'), draft())).toEqual({ name: 'Renamed' });
    const edited = retitle(GRAPH, 'payq', 'Able to pay?');
    expect(Object.keys(changedFields(draft(edited), draft()))).toEqual(['graph']);
  });

  it('judges the graph by value, not by key order or object identity', () => {
    const reordered = JSON.parse(JSON.stringify(GRAPH, ['nodes', 'startNodeId', 'id', 'type', 'title', 'text', 'next', 'choices', 'key', 'label', 'fields', 'required', 'position', 'x', 'y', 'suggestedDispositionId'])) as ScriptGraph;
    expect(changedFields(draft(reordered), draft())).toEqual({});
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe('the rebase after a 409 (D-L102, R5)', () => {
  it('keeps the other person’s change to a node this person never touched, and re-applies this person’s', () => {
    const base = draft();
    const local = draft(retitle(GRAPH, 'payq', 'Able to pay?'));
    const fresh = draft(
      { ...GRAPH, nodes: GRAPH.nodes.map((node) => (node.id === 'greet' ? { ...node, text: 'Good afternoon.' } : node)) },
      'Collections (reviewed)',
    );
    const { draft: rebased, conflicts } = rebase(base, local, fresh);
    expect(rebased.name, 'the untouched name took the other person’s').toBe('Collections (reviewed)');
    expect(rebased.graph.nodes.find((node) => node.id === 'greet')).toEqual(fresh.graph.nodes.find((node) => node.id === 'greet'));
    expect(rebased.graph.nodes.find((node) => node.id === 'payq')?.title).toBe('Able to pay?');
    expect(conflicts).toEqual({});
    // The next save sends only the graph: the name equals what the re-read served.
    expect(Object.keys(changedFields(rebased, fresh))).toEqual(['graph']);
  });

  it('keeps the typed value of a field both people changed, and names it', () => {
    const { draft: rebased, conflicts } = rebase(draft(), draft(retitle(GRAPH, 'payq', 'Mine')), draft(retitle(GRAPH, 'payq', 'Theirs')));
    expect(rebased.graph.nodes.find((node) => node.id === 'payq')?.title).toBe('Mine');
    expect(conflicts).toEqual({ payq: ['title'] });
  });

  it('merges a node field by field when both changed different fields of it', () => {
    const mine = { ...GRAPH, nodes: GRAPH.nodes.map((node) => (node.id === 'payq' ? { ...node, title: 'Mine' } : node)) };
    const theirs = { ...GRAPH, nodes: GRAPH.nodes.map((node) => (node.id === 'payq' ? { ...node, text: 'Their wording' } : node)) };
    const { draft: rebased, conflicts } = rebase(draft(), draft(mine), draft(theirs));
    expect(rebased.graph.nodes.find((node) => node.id === 'payq')).toMatchObject({ title: 'Mine', text: 'Their wording' });
    expect(conflicts).toEqual({});
  });

  it('keeps a node added here and one added there; a node deleted here that they changed comes back', () => {
    const added: ScriptNode = { id: 'say_1', type: 'say', title: 'New', text: 'x', next: 'close' };
    const local = draft({ ...GRAPH, nodes: [...GRAPH.nodes.filter((node) => node.id !== 'rec'), added] });
    const theirAdd: ScriptNode = { id: 'end_9', type: 'end', title: 'Theirs' };
    const fresh = draft({ ...GRAPH, nodes: [...GRAPH.nodes.map((node) => (node.id === 'rec' ? { ...node, text: 'Changed.' } : node)), theirAdd] });
    const ids = rebase(draft(), local, fresh).draft.graph.nodes.map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(['say_1', 'end_9', 'rec']));
    // Deleted here and untouched there: it stays deleted.
    const untouched = rebase(draft(), local, draft()).draft.graph.nodes.map((node) => node.id);
    expect(untouched).not.toContain('rec');
  });

  it('flags a name both people changed', () => {
    const { draft: rebased, conflicts } = rebase(draft(), draft(GRAPH, 'Mine'), draft(GRAPH, 'Theirs'));
    expect(rebased.name).toBe('Mine');
    expect(conflicts[NAME_CONFLICT]).toEqual(['name']);
  });
});

describe('translations are PUT whole, per changed locale (R10)', () => {
  const served = { greet: { text: 'Bawo' }, payq: { text: 'Ṣe o le san?', choices: { yes: 'Bẹ́ẹ̀ ni' } } };

  it('keeps every node it was served and lays the edits over them', () => {
    expect(translationBody(served, { rec: 'Gbigbasilẹ' })).toEqual({ ...served, rec: { text: 'Gbigbasilẹ' } });
    expect(translationBody(served, { payq: '' })).toEqual({ greet: { text: 'Bawo' }, payq: { choices: { yes: 'Bẹ́ẹ̀ ni' } } });
    expect(translationBody(served, { greet: '' })).toEqual({ payq: served.payq });
  });

  it('names only the locales whose whole body changed', () => {
    expect(changedLocales(['yo', 'ha'], { yo: served }, { yo: { greet: 'Bawo' }, ha: { greet: 'Sannu' } })).toEqual(['ha']);
  });
});

describe('a node added from the palette is shape-valid (R6)', () => {
  it('gives every kind what the contract requires', () => {
    for (const type of ['say', 'question', 'form', 'branch', 'compliance', 'end'] as const) {
      const node = newNode(type, GRAPH, WORDS);
      expect(node.type).toBe(type);
      expect(node.id).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      expect(GRAPH.nodes.some((existing) => existing.id === node.id)).toBe(false);
      expect(ScriptGraph.safeParse({ ...GRAPH, nodes: [...GRAPH.nodes, node] }).success).toBe(true);
    }
    const question = newNode('question', GRAPH, WORDS);
    expect(question.type === 'question' && question.choices.length).toBe(2);
    const form = newNode('form', GRAPH, WORDS);
    expect(form.type === 'form' && form.fields.length).toBe(1);
    expect(newNode('branch', GRAPH, WORDS)).toMatchObject({ condition: { source: 'contact_field', field: 'status', operator: 'is_set' }, whenTrue: 'close' });
  });

  it('places a new node under the lowest one, and never repeats an id', () => {
    const one = newNode('say', GRAPH, WORDS);
    const two = newNode('say', { ...GRAPH, nodes: [...GRAPH.nodes, one] }, WORDS);
    expect(two.id).not.toBe(one.id);
    expect(one.position?.y).toBeGreaterThan(30);
  });
});

describe('branch conditions are chosen, never typed (P10/05)', () => {
  it('offers only Contact wire names, never the envelope', () => {
    expect(BRANCH_FIELDS).not.toContain('withheldFields');
    expect(BRANCH_FIELDS).not.toContain('id');
    expect(BRANCH_FIELDS).toContain('status');
  });

  it('carries the value over in the shape the operator takes', () => {
    const condition = { source: 'contact_field' as const, field: 'status', operator: 'one_of' as const, value: ['customer'] };
    expect(withOperator(condition, 'equals')).toEqual({ source: 'contact_field', field: 'status', operator: 'equals', value: 'customer' });
    expect(withOperator(condition, 'is_set')).toEqual({ source: 'contact_field', field: 'status', operator: 'is_set' });
    expect(withOperator({ ...condition, operator: 'equals', value: 'x' }, 'one_of').value).toEqual(['x']);
  });

  it('reads the value box as the operator and field take it', () => {
    const base = { source: 'contact_field' as const, field: 'preferredLanguage', operator: 'equals' as const };
    expect(parseValue(base, ' pcm ')).toBe('pcm');
    expect(parseValue({ ...base, operator: 'one_of' }, 'a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(parseValue({ ...base, field: 'dnd' }, 'true')).toBe(true);
    expect(parseValue({ ...base, operator: 'greater_than' }, '12')).toBe(12);
    expect(parseValue({ ...base, operator: 'is_set' }, 'x')).toBeUndefined();
  });

  it('switches to an answer condition on a node that asks something', () => {
    const condition = { source: 'contact_field' as const, field: 'status', operator: 'is_set' as const };
    expect(conditionForSource('answer', condition, GRAPH)).toEqual({ source: 'answer', nodeId: 'payq', operator: 'equals', value: 'yes' });
    expect(conditionForSource('answer', condition, { startNodeId: 'close', nodes: [GRAPH.nodes[4] as ScriptNode] })).toBe(condition);
  });
});

describe('variables and form fields', () => {
  it('offers the three families only: contact fields, the agent, and the graph’s form answers', () => {
    const variables = variablesFor(GRAPH).map((entry) => entry.variable);
    expect(variables).toEqual(expect.arrayContaining(['contact.displayName', 'agent.displayName', 'answer.ptp.date']));
    expect(variables.every((variable) => /^(contact\.[a-z][A-Za-z0-9]*|agent\.displayName|answer\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/.test(variable))).toBe(true);
  });

  it('inserts a token at the caret, spaced from the word before it', () => {
    expect(insertToken('Hello', 5, '{agent.displayName}')).toEqual({ text: 'Hello {agent.displayName}', caret: 25 });
    expect(insertToken('Hello there', 0, '{x.y}')).toEqual({ text: '{x.y}Hello there', caret: 5 });
    expect(insertToken('a ', null, '{x.y}').text).toBe('a {x.y}');
  });

  it('gives a retyped field the bounds its type needs and nothing that binds it to a record (D-P31)', () => {
    const field = { key: 'amount', label: 'Amount', type: 'text' as const, required: true };
    const money = retypeField(field, 'money', 'NGN', 'Option');
    expect(money).toEqual({ key: 'amount', label: 'Amount', type: 'money', required: true, currency: 'NGN', minimumMinor: '0', maximumMinor: '999999999999999999' });
    expect(retypeField(money, 'choice', 'NGN', 'Option')).toEqual({ key: 'amount', label: 'Amount', type: 'choice', required: true, options: [{ key: 'option_1', label: 'Option' }] });
    expect(Object.keys(retypeField(money, 'date', 'NGN', 'Option')).sort()).toEqual(['key', 'label', 'required', 'type']);
  });
});

describe('the compliance diff and a refused publish', () => {
  it('names the compliance nodes added, changed and removed since the latest version', () => {
    const published: ScriptGraph = { ...GRAPH, nodes: [...GRAPH.nodes.map((node) => (node.id === 'rec' ? { ...node, text: 'Old wording.' } : node)), { id: 'gone', type: 'compliance', title: 'Gone', text: 'x', next: 'close' }] };
    const draftGraph: ScriptGraph = { ...GRAPH, nodes: [...GRAPH.nodes, { id: 'crb', type: 'compliance', title: 'Credit bureau notice', text: 'y', next: 'close' }] };
    const diff = complianceDiff(draftGraph, published);
    expect(diff.added.map((node) => node.id)).toEqual(['crb']);
    expect(diff.changed.map((node) => node.id)).toEqual(['rec']);
    expect(diff.removed.map((node) => node.id)).toEqual(['gone']);
    expect(complianceDiff(GRAPH, GRAPH)).toEqual({ added: [], changed: [], removed: [] });
  });

  it('reads script_invalid details as nodes and reasons, never as raw paths', () => {
    expect(
      publishProblems([
        { path: 'nodes.payq.choices.cb.next', code: 'unknown_target' },
        { path: 'nodes.ptp', code: 'unreachable_end' },
        { path: 'draft', code: 'unchanged' },
        { path: 'nodes.ptp', code: 'unreachable_end' },
        { path: 'graph', code: 'something_new' },
      ]),
    ).toEqual([
      { nodeId: 'payq', reason: 'unknown_target' },
      { nodeId: 'ptp', reason: 'unreachable_end' },
      { nodeId: null, reason: 'unchanged' },
      { nodeId: null, reason: null },
    ]);
  });
});
