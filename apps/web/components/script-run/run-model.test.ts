import { describe, expect, it } from 'vitest';
import type { ScriptGraph, ScriptVersion } from '../../lib/script-graph';
import type { RunContact, ScriptRun } from '../../lib/script-runs-api';
import {
  completionOffered,
  fieldErrors,
  fill,
  formatAnswer,
  initialLocale,
  inputsFromAnswers,
  localesOf,
  readForm,
  stepsOf,
  suggestedDisposition,
  toMajor,
  toMinor,
  wordingFor,
} from './run-model';

const GRAPH: ScriptGraph = {
  startNodeId: 'greet',
  nodes: [
    { id: 'greet', type: 'say', title: 'Greeting', text: 'Hello {contact.displayName}, I am {agent.displayName}.', next: 'rec' },
    { id: 'rec', type: 'compliance', title: 'Recording notice', text: 'This call is recorded.', next: 'cust' },
    { id: 'cust', type: 'branch', title: 'Customer?', condition: { source: 'contact_field', field: 'status', operator: 'is_set' }, whenTrue: 'payq', whenFalse: 'close' },
    { id: 'payq', type: 'question', title: 'Can pay?', text: 'Can you pay?', choices: [{ key: 'yes', label: 'Yes', next: 'ptp' }, { key: 'no', label: 'No', next: 'close' }] },
    {
      id: 'ptp',
      type: 'form',
      title: 'Promise',
      text: 'You will pay {answer.ptp.amount} on {answer.ptp.date}. {contact.emails}',
      next: 'close',
      fields: [
        { key: 'date', label: 'Date', type: 'date', required: true },
        { key: 'amount', label: 'Amount', type: 'money', required: true, currency: 'NGN', minimumMinor: '500000', maximumMinor: '100000000' },
        { key: 'reason', label: 'Reason', type: 'choice', required: true, options: [{ key: 'salary_delayed', label: 'Salary delayed' }] },
        { key: 'count', label: 'Count', type: 'number', required: false },
        { key: 'detail', label: 'Detail', type: 'text', required: false, maxLength: 5 },
      ],
    },
    { id: 'close', type: 'end', title: 'Close', text: 'Bye.', suggestedDispositionId: '9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b21' },
  ],
};

const VERSION: ScriptVersion = {
  id: 'v',
  scriptId: 's',
  number: 13,
  name: 'Collections',
  sourceLocale: 'en',
  graph: GRAPH,
  translations: { pcm: { rec: { text: 'We dey record this call.' }, payq: { choices: { yes: 'Yes o' } } } },
  changes: [],
  publishedAt: '2026-10-07T13:55:00Z',
  publishedBy: null,
};

const T0 = '2026-10-12T09:00:00Z';

function run(overrides: Partial<ScriptRun>): ScriptRun {
  return {
    id: 'r',
    programmeId: 'p',
    contactId: 'c',
    scriptId: 's',
    versionId: 'v',
    versionNumber: 13,
    latestVersion: { id: 'v', number: 13, publishedAt: T0, publishedBy: null },
    status: 'in_progress',
    outcome: null,
    unacknowledgedComplianceNodeIds: [],
    endedAtNodeId: null,
    stopReason: null,
    currentNodeId: 'greet',
    path: [{ nodeId: 'greet', enteredAt: T0 }],
    acknowledgements: [],
    answers: {},
    startedBy: { id: 'a', displayName: 'Kemi Balogun' },
    completedAt: null,
    dispositionId: null,
    followUpTaskId: null,
    revision: 1,
    ...overrides,
  };
}

const CONTACT: RunContact = { id: 'c', displayName: 'Adaeze Okonkwo', withheldFields: ['emails'] };

describe('the steps are the run’s path, as the server sent it (R3)', () => {
  it('draws entered nodes in order, skips a branch passed through, and marks the current one', () => {
    const steps = stepsOf(
      run({ currentNodeId: 'payq', path: [{ nodeId: 'greet', enteredAt: T0 }, { nodeId: 'rec', enteredAt: T0 }, { nodeId: 'cust', enteredAt: T0, branchOutcome: true }, { nodeId: 'payq', enteredAt: T0 }] }),
      GRAPH,
    );
    expect(steps.map((step) => [step.node.id, step.current])).toEqual([
      ['greet', false],
      ['rec', false],
      ['payq', true],
    ]);
  });

  it('draws a branch only when the run stopped on it', () => {
    const stopped = run({ status: 'stopped', stopReason: 'field_withheld', currentNodeId: 'cust', path: [{ nodeId: 'greet', enteredAt: T0 }, { nodeId: 'cust', enteredAt: T0, branchOutcome: null }] });
    expect(stepsOf(stopped, GRAPH).map((step) => [step.node.id, step.current])).toEqual([
      ['greet', false],
      ['cust', true],
    ]);
  });

  it('has no current step once completed', () => {
    expect(stepsOf(run({ status: 'completed', currentNodeId: null }), GRAPH).some((step) => step.current)).toBe(false);
  });
});

describe('completion offered (R4, D-L93)', () => {
  it('is completed at an end node or a stopped run, interrupted anywhere else, nothing once completed', () => {
    expect(completionOffered(run({ currentNodeId: 'close' }), GRAPH)).toBe('completed');
    expect(completionOffered(run({ status: 'stopped', currentNodeId: 'cust' }), GRAPH)).toBe('completed');
    expect(completionOffered(run({ currentNodeId: 'rec' }), GRAPH)).toBe('interrupted');
    expect(completionOffered(run({ status: 'completed', currentNodeId: null }), GRAPH)).toBeNull();
  });

  it('pre-chooses the end node’s suggestion, and nothing away from an end', () => {
    expect(suggestedDisposition(run({ currentNodeId: 'close' }), GRAPH)).toBe('9d1b4e70-2c5a-4e8f-b6d3-1a7c0e9f4b21');
    expect(suggestedDisposition(run({ currentNodeId: 'rec' }), GRAPH)).toBeNull();
  });
});

describe('languages (R5)', () => {
  it('offers the pinned version’s source and translated locales', () => {
    expect(localesOf(VERSION)).toEqual(['en', 'pcm']);
    expect(initialLocale(VERSION, 'pcm')).toBe('pcm');
    expect(initialLocale(VERSION, 'en-XA')).toBe('en');
    expect(initialLocale(VERSION, 'ha')).toBe('en');
  });

  it('shows the translation when there is one, and says when it falls back to the source', () => {
    const rec = GRAPH.nodes[1];
    const payq = GRAPH.nodes[3];
    if (rec === undefined || payq === undefined) throw new Error('fixture');
    expect(wordingFor(rec, VERSION, 'pcm')).toMatchObject({ text: 'We dey record this call.', shown: 'pcm', fallback: false });
    const fallback = wordingFor(payq, VERSION, 'pcm');
    expect(fallback).toMatchObject({ text: 'Can you pay?', shown: 'en', fallback: true });
    expect(fallback.choiceLabel('yes', 'Yes')).toBe('Yes o');
    expect(wordingFor(rec, VERSION, 'en')).toMatchObject({ shown: 'en', fallback: false });
  });
});

describe('variables are filled from what the screen holds; a withheld one is a placeholder', () => {
  const context = {
    contact: CONTACT,
    agentName: 'Kemi Balogun',
    answers: { ptp: { type: 'form' as const, values: { amount: { amountMinor: '2500000', currency: 'NGN' }, date: '2026-10-15' }, updatedAt: T0 } },
    graph: GRAPH,
    locale: 'en',
  };

  it('fills the contact, the agent and an answer, formatted, and never prints a variable raw', () => {
    const text = fill('Hello {contact.displayName}, I am {agent.displayName}.', context)
      .map((segment) => (segment.kind === 'text' ? segment.text : '[?]'))
      .join('');
    expect(text).toBe('Hello Adaeze Okonkwo, I am Kemi Balogun.');
    const readback = fill('{answer.ptp.amount} on {answer.ptp.date}', context);
    const said = readback.map((segment) => (segment.kind === 'text' ? segment.text : '')).join('');
    expect(said).toMatch(/25[,.\s]?000/);
    expect(said).not.toContain('2500000');
    expect(said).toContain('2026');
  });

  it('draws a withheld field, a missing contact and an unanswered field as placeholders', () => {
    expect(fill('{contact.emails}', context)).toEqual([{ kind: 'placeholder', variable: 'contact.emails' }]);
    expect(fill('{contact.displayName}', { ...context, contact: null })).toEqual([{ kind: 'placeholder', variable: 'contact.displayName' }]);
    expect(fill('{answer.ptp.reason}', context)).toEqual([{ kind: 'placeholder', variable: 'answer.ptp.reason' }]);
    expect(fill('{agent.displayName}', { ...context, agentName: null })[0]?.kind).toBe('placeholder');
  });

  it('leaves text that is not one of the three families alone, as text', () => {
    expect(fill('{loan.balance} <b>x</b>', context)).toEqual([{ kind: 'text', text: '{loan.balance} <b>x</b>' }]);
  });
});

describe('money: typed in major units, sent in minor units as a string (R6)', () => {
  it('converts by string arithmetic, never a float', () => {
    expect(toMinor('25000', 'NGN')).toBe('2500000');
    expect(toMinor('25,000.5', 'NGN')).toBe('2500050');
    expect(toMinor('0.01', 'NGN')).toBe('1');
    expect(toMinor('12345678901234.56', 'NGN')).toBe('1234567890123456');
    expect(toMinor('25.001', 'NGN')).toBeNull();
    expect(toMinor('abc', 'NGN')).toBeNull();
    expect(toMinor('-5', 'NGN')).toBeNull();
    expect(toMinor('500', 'XOF')).toBe('500');
  });

  it('turns minor units back into what was typed', () => {
    expect(toMajor('2500000', 'NGN')).toBe('25000');
    expect(toMajor('2500050', 'NGN')).toBe('25000.5');
    expect(toMajor('5', 'NGN')).toBe('0.05');
  });

  it('formats an answer for the read-back', () => {
    expect(formatAnswer(undefined, { amountMinor: '2500000', currency: 'NGN' }, 'en')).toMatch(/25,000\.00/);
    expect(formatAnswer({ key: 'r', label: 'R', type: 'choice', required: true, options: [{ key: 'a', label: 'Apple' }] }, 'a', 'en')).toBe('Apple');
    expect(formatAnswer(undefined, null, 'en')).toBeNull();
  });

  it('reads a malformed amount as unavailable instead of throwing in the render', () => {
    for (const amountMinor of ['12.50', '', 'abc', '1e3', ' 5']) {
      expect(() => formatAnswer(undefined, { amountMinor, currency: 'NGN' }, 'en')).not.toThrow();
      expect(formatAnswer(undefined, { amountMinor, currency: 'NGN' }, 'en')).toBeNull();
      expect(() => toMajor(amountMinor, 'NGN')).not.toThrow();
      expect(toMajor(amountMinor, 'NGN')).toBe('');
    }
    const form = GRAPH.nodes[4];
    if (form === undefined || form.type !== 'form') throw new Error('fixture');
    const saved = { type: 'form' as const, values: { amount: { amountMinor: '12.50', currency: 'NGN' } }, updatedAt: T0 };
    expect(() => inputsFromAnswers(form.fields, saved)).not.toThrow();
    expect(inputsFromAnswers(form.fields, saved).amount).toBe('');
  });

  it('keeps the sign of a negative amount, under one major unit too', () => {
    expect(toMajor('-2500050', 'NGN')).toBe('-25000.5');
    expect(toMajor('-5', 'NGN')).toBe('-0.05');
    expect(toMajor('-0', 'NGN')).toBe('0');
    expect(formatAnswer(undefined, { amountMinor: '-5', currency: 'NGN' }, 'en')).toMatch(/^-.*0\.05$/);
    expect(formatAnswer(undefined, { amountMinor: '-2500000', currency: 'NGN' }, 'en')).toMatch(/^-.*25,000\.00$/);
  });
});

describe('forms record answers on the run only (D-P31)', () => {
  const form = GRAPH.nodes[4];
  if (form === undefined || form.type !== 'form') throw new Error('fixture');

  it('reads the inputs as answers, refusing a missing required field before anything is sent', () => {
    const missing = readForm(form.fields, { date: '2026-10-15', amount: '25000' }, undefined);
    expect(missing.errors).toEqual({ reason: 'required' });
    const read = readForm(form.fields, { date: '2026-10-15', amount: '25000', reason: 'salary_delayed', count: '3', detail: 'ok' }, undefined);
    expect(read.errors).toEqual({});
    expect(read.values).toEqual({ date: '2026-10-15', amount: { amountMinor: '2500000', currency: 'NGN' }, reason: 'salary_delayed', count: 3, detail: 'ok' });
  });

  it('says what is wrong with an amount, a number or text that is too long', () => {
    const read = readForm(form.fields, { date: 'x', amount: '25,000.555', reason: 'salary_delayed', count: '1.5', detail: 'too long' }, undefined);
    expect(read.errors).toEqual({ amount: 'invalid_amount', count: 'invalid_type', detail: 'too_big' });
  });

  it('clears a saved optional answer with null, and starts the inputs from what is on the run', () => {
    const saved = { type: 'form' as const, values: { detail: 'hi', amount: { amountMinor: '2500000', currency: 'NGN' } }, updatedAt: T0 };
    expect(readForm(form.fields, { date: '2026-10-15', amount: '25000', reason: 'salary_delayed', detail: '' }, saved).values.detail).toBeNull();
    expect(inputsFromAnswers(form.fields, saved)).toEqual({ date: '', amount: '25000', reason: '', count: '', detail: 'hi' });
  });

  it('maps the server’s values.<key> details to field errors, and nothing else', () => {
    expect(fieldErrors([{ path: 'values.amount', code: 'too_small' }, { path: 'nodeId', code: 'not_on_path' }, { path: 'values.amount', code: 'too_big' }])).toEqual({ amount: 'too_small' });
  });
});
