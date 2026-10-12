import { describe, expect, it } from 'vitest';
import type { StoredGraph } from './script-graph';
import {
  acknowledgedLocale,
  acknowledgeProblem,
  advanceFrom,
  answerNodeProblem,
  answerProblems,
  answersBytes,
  choiceProblem,
  completionDecision,
  completionDigest,
  conditionHolds,
  enterNode,
  mergeFormAnswer,
  nodesById,
  profileLocaleOf,
  stoppedOnField,
  storedPath,
  todayIn,
  type FieldReader,
  type FormNode,
  type RunAcknowledgement,
  type RunAnswers,
  type RunStep,
} from './script-run-engine';

/**
 * The pure run rules (T-0114): branches on entry, advance, acknowledgements,
 * answers and completion. No database, no clock: `now` is passed in.
 */

const NOW = '2026-10-12T10:00:00.000Z';

/** greet -> rec (compliance) -> idq (question) -> cust (branch on status) -> pay | intro -> pay -> ptp (form) -> close (end). */
const GRAPH: StoredGraph = {
  startNodeId: 'greet',
  nodes: [
    { id: 'greet', type: 'say', title: 'Hi', text: 'Hello', next: 'rec' },
    { id: 'rec', type: 'compliance', title: 'Rec', text: 'Recorded', next: 'idq' },
    {
      id: 'idq',
      type: 'question',
      title: 'Q',
      text: 'Holder?',
      choices: [
        { key: 'yes', label: 'Yes', next: 'cust' },
        { key: 'no', label: 'No', next: 'stop' },
      ],
    },
    {
      id: 'cust',
      type: 'branch',
      title: 'Customer?',
      condition: { source: 'contact_field', field: 'status', operator: 'one_of', value: ['customer'] },
      whenTrue: 'pay',
      whenFalse: 'intro',
    },
    { id: 'intro', type: 'say', title: 'Intro', text: 'Offer', next: 'pay' },
    {
      id: 'pay',
      type: 'branch',
      title: 'Said yes?',
      condition: { source: 'answer', nodeId: 'idq', operator: 'equals', value: 'yes' },
      whenTrue: 'ptp',
      whenFalse: 'stop',
    },
    {
      id: 'ptp',
      type: 'form',
      title: 'PTP',
      text: 'Agree',
      fields: [
        { key: 'date', label: 'Date', type: 'date', required: true, minDaysAhead: 0, maxDaysAhead: 14 },
        {
          key: 'amount',
          label: 'Amount',
          type: 'money',
          required: true,
          currency: 'NGN',
          minimumMinor: '500000',
          maximumMinor: '100000000',
        },
        {
          key: 'reason',
          label: 'Reason',
          type: 'choice',
          required: false,
          options: [{ key: 'salary_delayed', label: 'Salary' }],
        },
        { key: 'count', label: 'Count', type: 'number', required: false, minimum: 0, maximum: 10 },
        { key: 'memo', label: 'Memo', type: 'text', required: false, maxLength: 5 },
      ],
      next: 'readback',
    },
    { id: 'readback', type: 'compliance', title: 'RB', text: 'Read back', next: 'close' },
    { id: 'close', type: 'end', title: 'Close' },
    { id: 'stop', type: 'end', title: 'Stop' },
  ],
};

const byId = nodesById(GRAPH);
const node = (id: string) => {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`fixture: no node ${id}`);
  return found;
};
const form = node('ptp') as FormNode;

const reader =
  (readings: Record<string, Awaited<ReturnType<FieldReader>>>): FieldReader =>
  async (field) =>
    readings[field] ?? { kind: 'withheld' };

const ack = (nodeId: string): RunAcknowledgement => ({
  nodeId,
  locale: 'en',
  profileLocale: null,
  acknowledgedAt: NOW,
});

describe('conditionHolds', () => {
  it('treats missing, null and an empty list as not set, and every comparison with them as false', () => {
    for (const value of [undefined, null, []]) {
      expect(conditionHolds({ operator: 'is_set' }, value)).toBe(false);
      expect(conditionHolds({ operator: 'is_not_set' }, value)).toBe(true);
      expect(conditionHolds({ operator: 'equals', value: 'x' }, value)).toBe(false);
      expect(conditionHolds({ operator: 'not_equals', value: 'x' }, value)).toBe(false);
      expect(conditionHolds({ operator: 'greater_than', value: 1 }, value)).toBe(false);
    }
  });

  it('compares scalars, lists and money', () => {
    expect(conditionHolds({ operator: 'equals', value: 'customer' }, 'customer')).toBe(true);
    expect(conditionHolds({ operator: 'not_equals', value: 'customer' }, 'lead')).toBe(true);
    expect(conditionHolds({ operator: 'one_of', value: ['a', 'b'] }, 'b')).toBe(true);
    expect(conditionHolds({ operator: 'one_of', value: ['a', 'b'] }, 'c')).toBe(false);
    expect(conditionHolds({ operator: 'equals', value: 'vip' }, ['new', 'vip'])).toBe(true);
    expect(conditionHolds({ operator: 'equals', value: true }, true)).toBe(true);
    expect(conditionHolds({ operator: 'greater_than', value: 3 }, 4)).toBe(true);
    expect(conditionHolds({ operator: 'less_than', value: 3 }, 4)).toBe(false);
    const money = { amountMinor: '2500000', currency: 'NGN' };
    expect(conditionHolds({ operator: 'greater_than', value: 2_000_000 }, money)).toBe(true);
    expect(conditionHolds({ operator: 'greater_than', value: 3 }, 'not a number')).toBe(false);
  });
});

describe('enterNode: branches are evaluated on entry, on the server', () => {
  it('follows both sides of a contact-field branch and records the side taken', async () => {
    const path: RunStep[] = [{ nodeId: 'idq', enteredAt: NOW }];
    const answers: RunAnswers = { idq: { type: 'question', choiceKey: 'yes', answeredAt: NOW } };
    const customer = await enterNode(
      GRAPH,
      'cust',
      path,
      answers,
      reader({ status: { kind: 'value', value: 'customer' } }),
      NOW,
    );
    expect(customer.stopReason).toBeNull();
    expect(customer.currentNodeId).toBe('ptp');
    expect(customer.path.map((step) => [step.nodeId, step.branchOutcome ?? null])).toEqual([
      ['idq', null],
      ['cust', true],
      ['pay', true],
      ['ptp', null],
    ]);

    const other = await enterNode(
      GRAPH,
      'cust',
      path,
      answers,
      reader({ status: { kind: 'value', value: null } }),
      NOW,
    );
    expect(other.currentNodeId).toBe('intro');
    expect(other.path.at(-2)).toEqual({ nodeId: 'cust', enteredAt: NOW, branchOutcome: false });
  });

  it('stops on a withheld field (field_withheld) and on a sensitive one (sensitive_field), never reading a value', async () => {
    let asked = 0;
    const counting =
      (kind: 'withheld' | 'sensitive'): FieldReader =>
      async () => {
        asked += 1;
        return { kind };
      };
    const withheld = await enterNode(GRAPH, 'cust', [], {}, counting('withheld'), NOW);
    expect(withheld).toEqual({
      path: [{ nodeId: 'cust', enteredAt: NOW, branchOutcome: null }],
      currentNodeId: 'cust',
      stopReason: 'field_withheld',
    });
    const sensitive = await enterNode(GRAPH, 'cust', [], {}, counting('sensitive'), NOW);
    expect(sensitive.stopReason).toBe('sensitive_field');
    expect(sensitive.currentNodeId).toBe('cust');
    expect(asked).toBe(2);
  });

  it('a branch on an answer reads the run, never the contact', async () => {
    const never: FieldReader = async () => {
      throw new Error('read a contact field');
    };
    const refused = await enterNode(
      GRAPH,
      'pay',
      [],
      { idq: { type: 'question', choiceKey: 'no', answeredAt: NOW } },
      never,
      NOW,
    );
    expect(refused.currentNodeId).toBe('stop');
  });

  it('names the contact field a stopped run stopped on, and nothing for any other node', () => {
    expect(stoppedOnField(GRAPH, 'cust')).toBe('status');
    expect(stoppedOnField(GRAPH, 'pay')).toBeNull();
    expect(stoppedOnField(GRAPH, 'greet')).toBeNull();
    expect(stoppedOnField(GRAPH, null)).toBeNull();
  });
});

describe('advance', () => {
  it('needs one of a question’s own choices, and a choice only on a question', () => {
    expect(choiceProblem(node('idq'), undefined)).toEqual({ path: 'choiceKey', code: 'required' });
    expect(choiceProblem(node('idq'), 'ptp')).toEqual({ path: 'choiceKey', code: 'unknown_choice' });
    expect(choiceProblem(node('idq'), 'yes')).toBeNull();
    expect(choiceProblem(node('greet'), 'yes')).toEqual({
      path: 'choiceKey',
      code: 'not_a_question',
    });
    expect(choiceProblem(node('greet'), undefined)).toBeNull();
  });

  it('refuses the end, an unacknowledged compliance node and a form missing required answers', () => {
    expect(advanceFrom(node('close'), [], {}, undefined)).toEqual({ kind: 'run_at_end' });
    expect(advanceFrom(node('rec'), [], {}, undefined)).toEqual({
      kind: 'compliance_unacknowledged',
      details: [{ path: 'nodes.rec', code: 'not_acknowledged' }],
    });
    expect(advanceFrom(node('rec'), [ack('rec')], {}, undefined)).toEqual({
      kind: 'next',
      nodeId: 'idq',
    });
    const partial: RunAnswers = {
      ptp: { type: 'form', values: { amount: { amountMinor: '600000', currency: 'NGN' } }, updatedAt: NOW },
    };
    expect(advanceFrom(form, [], partial, undefined)).toEqual({
      kind: 'answers_incomplete',
      details: [{ path: 'values.date', code: 'required' }],
    });
    expect(advanceFrom(node('idq'), [], {}, 'no')).toEqual({ kind: 'next', nodeId: 'stop' });
  });
});

describe('acknowledgements', () => {
  const path: RunStep[] = [
    { nodeId: 'greet', enteredAt: NOW },
    { nodeId: 'rec', enteredAt: NOW },
  ];

  it('only a compliance node on the path', () => {
    expect(acknowledgeProblem(GRAPH, path, 'rec')).toBeNull();
    expect(acknowledgeProblem(GRAPH, path, 'greet')).toEqual({ path: 'nodeId', code: 'not_compliance' });
    expect(acknowledgeProblem(GRAPH, path, 'readback')).toEqual({ path: 'nodeId', code: 'not_on_path' });
    expect(acknowledgeProblem(GRAPH, path, 'ghost')).toEqual({ path: 'nodeId', code: 'not_on_path' });
  });

  it('records the reported locale only when its translation has text for the node', () => {
    const translations = { pcm: { rec: { text: 'We dey record' }, readback: { title: 'RB' } } };
    expect(acknowledgedLocale('pcm', 'en', translations, 'rec')).toBe('pcm');
    expect(acknowledgedLocale('pcm', 'en', translations, 'readback')).toBe('en');
    expect(acknowledgedLocale('ha', 'en', translations, 'rec')).toBe('en');
    expect(acknowledgedLocale('fr', 'fr', {}, 'rec')).toBe('fr');
    expect(acknowledgedLocale('en', 'fr', {}, 'rec')).toBe('fr');
  });

  it('records a profile locale that is exactly one of the seven, else null (R9)', () => {
    expect(profileLocaleOf('pcm')).toBe('pcm');
    expect(profileLocaleOf('de-DE')).toBeNull();
    expect(profileLocaleOf('en-NG')).toBeNull();
    expect(profileLocaleOf(null)).toBeNull();
  });
});

describe('answers', () => {
  const today = '2026-10-12';

  it('only a form node on the path', () => {
    const path: RunStep[] = [{ nodeId: 'idq', enteredAt: NOW }];
    expect(answerNodeProblem(GRAPH, path, 'ptp')).toEqual({
      problem: { path: 'nodeId', code: 'not_on_path' },
    });
    expect(answerNodeProblem(GRAPH, path, 'idq')).toEqual({
      problem: { path: 'nodeId', code: 'not_a_form' },
    });
    expect(answerNodeProblem(GRAPH, [{ nodeId: 'ptp', enteredAt: NOW }], 'ptp')).toEqual({ node: form });
  });

  it('judges each value against its field, naming values.<key> and a code, never the value', () => {
    const cases: [string, unknown, string | null][] = [
      ['date', '2026-10-15', null],
      ['date', '2026-02-30', 'invalid_date'],
      ['date', 'next tuesday', 'invalid_date'],
      ['date', '2026-10-11', 'too_small'],
      ['date', '2026-10-27', 'too_big'],
      ['amount', { amountMinor: '600000', currency: 'NGN' }, null],
      ['amount', { amountMinor: '100', currency: 'NGN' }, 'too_small'],
      ['amount', { amountMinor: '100000001', currency: 'NGN' }, 'too_big'],
      ['amount', { amountMinor: '600000', currency: 'USD' }, 'currency_mismatch'],
      ['amount', { amountMinor: '25000.50', currency: 'NGN' }, 'invalid_money'],
      ['amount', 2_500_000, 'invalid_type'],
      ['amount', { amountMinor: '600000', currency: 'NGN', extra: 1 }, 'invalid_type'],
      ['reason', 'salary_delayed', null],
      ['reason', 'secret', 'not_an_option'],
      ['count', 3, null],
      ['count', 11, 'too_big'],
      ['count', -1, 'too_small'],
      ['count', 2_147_483_648, 'too_big'],
      ['count', 1.5, 'invalid_type'],
      ['count', '3', 'invalid_type'],
      ['memo', 'abcde', null],
      ['memo', '₦₦₦₦₦', null],
      ['memo', 'abcdef', 'too_big'],
      ['ghost', 'x', 'unknown_field_key'],
    ];
    for (const [key, value, code] of cases) {
      const problems = answerProblems(form, { [key]: value }, today);
      expect(problems, `${key} ${JSON.stringify(value)}`).toEqual(
        code === null ? [] : [{ path: `values.${key}`, code }],
      );
    }
    // null clears, whatever the field.
    expect(answerProblems(form, { date: null, amount: null }, today)).toEqual([]);
  });

  it('merges per node: only the keys sent change, and null removes a key', () => {
    let answers: RunAnswers = {};
    answers = mergeFormAnswer(answers, 'ptp', { memo: 'a' }, NOW);
    answers = mergeFormAnswer(answers, 'ptp', { count: 3 }, NOW);
    expect(answers.ptp).toEqual({ type: 'form', values: { memo: 'a', count: 3 }, updatedAt: NOW });
    answers = mergeFormAnswer(answers, 'ptp', { memo: null }, NOW);
    expect(answers.ptp).toEqual({ type: 'form', values: { count: 3 }, updatedAt: NOW });
  });

  it('counts the cap in UTF-8 bytes, not characters', () => {
    const naira: RunAnswers = {
      f: { type: 'form', values: { t: '₦'.repeat(1000) }, updatedAt: NOW },
    };
    expect(answersBytes(naira)).toBeGreaterThan(3000);
    expect(JSON.stringify(naira).length).toBeLessThan(1100);
  });

  it('counts today in the tenant’s zone', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    expect(todayIn('Africa/Lagos', new Date('2026-10-12T23:30:00Z'))).toBe('2026-10-13');
    expect(todayIn('UTC', new Date('2026-10-12T23:30:00Z'))).toBe('2026-10-12');
  });
});

describe('completion', () => {
  const walked: RunStep[] = ['greet', 'rec', 'idq', 'cust', 'pay', 'ptp', 'readback'].map(
    (nodeId) => ({ nodeId, enteredAt: NOW }),
  );

  it('completed only at an end or on a stopped run, with every compliance node acknowledged', () => {
    expect(
      completionDecision(
        GRAPH,
        { status: 'in_progress', currentNodeId: 'readback', path: walked, acknowledgements: [ack('rec')] },
        'completed',
      ),
    ).toEqual({ kind: 'refused', details: [{ path: 'outcome', code: 'not_at_end' }] });

    const atEnd = [...walked, { nodeId: 'close', enteredAt: NOW }];
    expect(
      completionDecision(
        GRAPH,
        { status: 'in_progress', currentNodeId: 'close', path: atEnd, acknowledgements: [ack('rec')] },
        'completed',
      ),
    ).toEqual({ kind: 'refused', details: [{ path: 'nodes.readback', code: 'not_acknowledged' }] });
    expect(
      completionDecision(
        GRAPH,
        {
          status: 'in_progress',
          currentNodeId: 'close',
          path: atEnd,
          acknowledgements: [ack('rec'), ack('readback')],
        },
        'completed',
      ),
    ).toEqual({ kind: 'allowed', unacknowledged: [] });

    const stopped = walked.slice(0, 4);
    expect(
      completionDecision(
        GRAPH,
        { status: 'stopped', currentNodeId: 'cust', path: stopped, acknowledgements: [ack('rec')] },
        'completed',
      ),
    ).toEqual({ kind: 'allowed', unacknowledged: [] });
  });

  it('interrupted excuses the current node, records the unread ones, and acknowledges nothing', () => {
    expect(
      completionDecision(
        GRAPH,
        {
          status: 'in_progress',
          currentNodeId: 'rec',
          path: walked.slice(0, 2),
          acknowledgements: [],
        },
        'interrupted',
      ),
    ).toEqual({ kind: 'allowed', unacknowledged: ['rec'] });
    expect(
      completionDecision(
        GRAPH,
        { status: 'in_progress', currentNodeId: 'readback', path: walked, acknowledgements: [ack('rec')] },
        'interrupted',
      ),
    ).toEqual({ kind: 'allowed', unacknowledged: ['readback'] });
    // A passed node with no acknowledgement (no write path makes one) is refused.
    expect(
      completionDecision(
        GRAPH,
        { status: 'in_progress', currentNodeId: 'readback', path: walked, acknowledgements: [] },
        'interrupted',
      ),
    ).toEqual({ kind: 'refused', details: [{ path: 'nodes.rec', code: 'not_acknowledged' }] });
  });

  it('an exact repeat has the same digest whatever its revision; any other request differs', () => {
    const base = {
      outcome: 'completed' as const,
      dispositionId: '01140000-0000-4000-8000-0000000D0001',
      note: 'Paid',
      followUp: { dueAt: '2026-10-20T14:00:00Z' },
    };
    const digest = completionDigest(base);
    expect(completionDigest({ ...base, dispositionId: base.dispositionId.toLowerCase() })).toBe(digest);
    expect(completionDigest({ ...base, followUp: { dueAt: '2026-10-20T14:00:00.000Z' } })).toBe(digest);
    for (const other of [
      { ...base, note: 'Different' },
      { ...base, note: undefined },
      { ...base, outcome: 'interrupted' as const },
      { ...base, followUp: undefined },
      { ...base, dispositionId: '01140000-0000-4000-8000-0000000d0002' },
    ]) {
      expect(completionDigest(other)).not.toBe(digest);
    }
    expect(digest).not.toContain('Paid');
  });
});

describe('stored shapes', () => {
  it('keeps branchOutcome only on branch steps, and reads garbage as an empty path', () => {
    expect(
      storedPath([
        { nodeId: 'a', enteredAt: NOW },
        { nodeId: 'b', enteredAt: NOW, branchOutcome: null },
      ]),
    ).toEqual([
      { nodeId: 'a', enteredAt: NOW },
      { nodeId: 'b', enteredAt: NOW, branchOutcome: null },
    ]);
    expect(storedPath({ not: 'a path' })).toEqual([]);
  });
});
