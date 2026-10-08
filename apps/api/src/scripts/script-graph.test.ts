import { describe, expect, it } from 'vitest';
import {
  codePoints,
  hasLoneSurrogate,
  ScriptGraphSchema,
  serialisedDraftBytes,
  stringProblems,
  translationMismatches,
  TranslationTextsSchema,
  type StoredGraph,
} from './script-graph';

const graph = () => ({
  startNodeId: 'greet',
  nodes: [
    { id: 'greet', type: 'say', title: 'Greeting', text: 'Hello.', next: 'ask' },
    {
      id: 'ask',
      type: 'question',
      title: 'Pay?',
      text: 'Can you pay?',
      choices: [
        { key: 'yes', label: 'Yes', next: 'form' },
        { key: 'no', label: 'No', next: 'done' },
      ],
    },
    {
      id: 'form',
      type: 'form',
      title: 'Promise',
      text: 'Agree the amount.',
      fields: [
        {
          key: 'amount',
          label: 'Amount',
          type: 'money',
          required: true,
          currency: 'NGN',
          minimumMinor: '100',
          maximumMinor: '900',
        },
      ],
      next: 'cust',
    },
    {
      id: 'cust',
      type: 'branch',
      title: 'Customer?',
      condition: { source: 'contact_field', field: 'status', operator: 'is_set' },
      whenTrue: 'done',
      whenFalse: 'done',
    },
    { id: 'done', type: 'end', title: 'Done' },
  ],
});

const paths = (input: unknown): string[] => {
  const result = ScriptGraphSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('script graph shape (T-0113)', () => {
  it('accepts a complete graph of every kind', () => {
    expect(ScriptGraphSchema.safeParse(graph()).success).toBe(true);
  });

  it('refuses a node kind outside the six, a free-form key and a record binding', () => {
    const g = graph();
    const disposition = { ...g, nodes: [...g.nodes.slice(0, 4), { id: 'done', type: 'disposition', title: 'x' }] };
    expect(paths(disposition)).toContain('nodes.4.type');
    expect(paths({ ...g, edges: [] })).toContain('');
    const writes = { ...g, nodes: [{ ...g.nodes[0], writesTo: 'status' }, ...g.nodes.slice(1)] };
    expect(paths(writes)).toContain('nodes.0');
  });

  it('refuses duplicate node ids, choice keys and field keys at their own paths', () => {
    const g = graph();
    expect(paths({ ...g, nodes: [...g.nodes, { id: 'done', type: 'end', title: 'Twin' }] })).toContain(
      'nodes.5.id',
    );
    const ask = g.nodes[1] as { choices: { key: string; label: string; next: string }[] };
    const twinChoice = {
      ...g,
      nodes: g.nodes.map((node, index) =>
        index === 1 ? { ...node, choices: [...ask.choices, { ...ask.choices[0] }] } : node,
      ),
    };
    expect(paths(twinChoice)).toContain('nodes.1.choices.2.key');
  });

  it('requires currency and both bounds for money, and options for choice', () => {
    const g = graph();
    const money = {
      ...g,
      nodes: g.nodes.map((node, index) =>
        index === 2
          ? { ...node, fields: [{ key: 'amount', label: 'Amount', type: 'money', required: true }] }
          : node,
      ),
    };
    expect(paths(money)).toEqual(
      expect.arrayContaining([
        'nodes.2.fields.0.currency',
        'nodes.2.fields.0.minimumMinor',
        'nodes.2.fields.0.maximumMinor',
      ]),
    );
    const choice = {
      ...g,
      nodes: g.nodes.map((node, index) =>
        index === 2
          ? { ...node, fields: [{ key: 'why', label: 'Why', type: 'choice', required: true }] }
          : node,
      ),
    };
    expect(paths(choice)).toContain('nodes.2.fields.0.options');
  });

  it('matches values to operators: none for is_set, a list for one_of, an integer to compare', () => {
    const g = graph();
    const withCondition = (condition: object) => ({
      ...g,
      nodes: g.nodes.map((node, index) => (index === 3 ? { ...node, condition } : node)),
    });
    const base = { source: 'contact_field', field: 'status' };
    expect(paths(withCondition({ ...base, operator: 'is_set', value: 'x' }))).toContain(
      'nodes.3.condition.value',
    );
    expect(paths(withCondition({ ...base, operator: 'one_of', value: 'x' }))).toContain(
      'nodes.3.condition.value',
    );
    expect(paths(withCondition({ ...base, operator: 'greater_than', value: 'x' }))).toContain(
      'nodes.3.condition.value',
    );
    expect(paths(withCondition({ ...base, operator: 'one_of', value: ['a'] }))).toEqual([]);
    expect(paths(withCondition({ ...base, operator: 'greater_than', value: 2147483648 }))).toContain(
      'nodes.3.condition.value',
    );
  });

  it('counts lengths in code points, not UTF-16 units', () => {
    expect(codePoints('😀'.repeat(120))).toBe(120);
    const g = graph();
    const titled = (title: string) => ({
      ...g,
      nodes: g.nodes.map((node, index) => (index === 0 ? { ...node, title } : node)),
    });
    expect(paths(titled('😀'.repeat(120)))).toEqual([]);
    expect(paths(titled('😀'.repeat(121)))).toContain('nodes.0.title');
  });
});

describe('stringProblems (T-0113)', () => {
  it('finds a NUL anywhere, by path, and never echoes the value', () => {
    const problems = stringProblems({ name: 'a\u0000b', graph: { nodes: [{ text: 'x\u0000' }] } });
    expect(problems).toEqual([
      { path: 'graph.nodes.0.text', code: 'nul_character' },
      { path: 'name', code: 'nul_character' },
    ]);
  });

  it('reports a bad object key at its parent, not by the key', () => {
    expect(stringProblems({ texts: { 'a\u0000': { text: 'x' } } })).toEqual([
      { path: 'texts', code: 'nul_character' },
    ]);
  });

  it('finds lone surrogates and leaves a valid pair alone', () => {
    expect(hasLoneSurrogate('half \ud800 a pair')).toBe(true);
    expect(hasLoneSurrogate('\udc00')).toBe(true);
    expect(hasLoneSurrogate('😀')).toBe(false);
    expect(stringProblems({ text: 'x\ud800' })).toEqual([
      { path: 'text', code: 'invalid_character' },
    ]);
  });

  it('walks a deeply nested body without recursion', () => {
    let deep: unknown = 'x\u0000';
    for (let index = 0; index < 50_000; index += 1) deep = [deep];
    expect(stringProblems(deep)).toHaveLength(1);
  });
});

describe('the size cap counts UTF-8 bytes (D-L96)', () => {
  it('counts ₦ as three bytes', () => {
    const one = serialisedDraftBytes({ t: 'a' }, {});
    const naira = serialisedDraftBytes({ t: '₦' }, {});
    expect(naira - one).toBe(2);
  });
});

describe('translationMismatches (T-0113)', () => {
  const stored = ScriptGraphSchema.parse(graph()) as StoredGraph;

  it('accepts what the graph has', () => {
    const texts = TranslationTextsSchema.parse({
      greet: { text: 'Sannu' },
      ask: { hint: 'h', choices: { yes: 'Eh' } },
      form: { fields: { amount: 'Kudi' } },
      cust: { title: 'Abokin ciniki?' },
    });
    expect(translationMismatches(stored, texts, 'texts')).toEqual([]);
  });

  it('names a node, choice or field the graph lacks, and a part the kind has not', () => {
    const texts = TranslationTextsSchema.parse({
      ghost: { text: 'x' },
      ask: { choices: { maybe: 'x' } },
      form: { fields: { ghost: 'x' } },
      cust: { text: 'branches have no text' },
      greet: { hint: 'only questions have hints' },
    });
    expect(translationMismatches(stored, texts, 'texts')).toEqual(
      expect.arrayContaining([
        { path: 'texts.ghost', code: 'unknown_node' },
        { path: 'texts.ask.choices.maybe', code: 'unknown_choice' },
        { path: 'texts.form.fields.ghost', code: 'unknown_field_key' },
        { path: 'texts.cust.text', code: 'not_translatable' },
        { path: 'texts.greet.hint', code: 'not_translatable' },
      ]),
    );
  });
});
