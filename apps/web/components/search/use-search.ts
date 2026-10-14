'use client';

import { useEffect, useMemo, useState } from 'react';
import { hasDetail, type RecordsError, type RecordsResult } from '../../lib/records-api';
import { lookupRecords, searchRecords, type SearchGroup } from '../../lib/search-api';
import { planSearch, type SearchPlan } from '../../lib/search-query';

/**
 * One search panel's reads (T-0087): what the box holds, planned by
 * `planSearch`, sent to searchRecords or lookupRecords, and the answer.
 *
 * DEBOUNCED. A name waits a quarter of a second after the last key; a number
 * or an address waits longer, so a number typed digit by digit at a human
 * pace is looked up once it is whole rather than refused at every digit past
 * the sixth. Each read is a round trip a 256 kbps user pays for.
 *
 * THE LATEST ANSWER WINS (R10). A newer query is sent at once, without
 * waiting for an older one; the older is aborted, and an answer (or a failure)
 * is drawn only if it answers the text in the box NOW. Nothing is cached:
 * typing the same thing twice asks twice, and nothing outlives the panel —
 * no recent searches, in memory or on the device (R19).
 */

export const NAME_DEBOUNCE_MS = 250;
export const LOOKUP_DEBOUNCE_MS = 600;

export type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'keepTyping' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'invalid'; readonly field: 'phone' | 'email' }
  | { readonly kind: 'error'; readonly error: RecordsError }
  | { readonly kind: 'results'; readonly groups: readonly SearchGroup[]; readonly q: string | null };

interface Answer {
  readonly key: string;
  readonly result: RecordsResult<readonly SearchGroup[]>;
}

/** How a plan and the answer to it (if any) are drawn. Pure, so the states are tested without a browser. */
export function panelState(plan: SearchPlan, answer: Answer | null): PanelState {
  switch (plan.kind) {
    case 'idle':
    case 'short':
      return { kind: 'idle' };
    case 'keepTyping':
      return { kind: 'keepTyping' };
    case 'refused':
      return { kind: 'invalid', field: plan.field };
    default:
      break;
  }
  if (answer === null || answer.key !== plan.key) return { kind: 'loading' };
  const { result } = answer;
  if (result.ok) return { kind: 'results', groups: result.value, q: plan.kind === 'search' ? plan.q : null };
  if (plan.kind === 'lookup') {
    // The lookup's own refusal of a value that is not one whole number or
    // address: a refusal, never a failure, and never a prefix search (R13).
    if (hasDetail(result.error, 'invalid_phone')) return { kind: 'invalid', field: 'phone' };
    if (hasDetail(result.error, 'invalid_email')) return { kind: 'invalid', field: 'email' };
  }
  return { kind: 'error', error: result.error };
}

export function useSearch(text: string): { readonly state: PanelState; readonly retry: () => void } {
  const plan = useMemo(() => planSearch(text), [text]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = plan.kind === 'search' || plan.kind === 'lookup' ? plan.key : null;

  useEffect(() => {
    if (plan.kind !== 'search' && plan.kind !== 'lookup') return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        const read =
          plan.kind === 'search'
            ? searchRecords(plan.q, controller.signal)
            : lookupRecords(plan.field, plan.value, controller.signal);
        void read.then((result) => {
          if (!controller.signal.aborted) setAnswer({ key: plan.key, result });
        });
      },
      plan.kind === 'search' ? NAME_DEBOUNCE_MS : LOOKUP_DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` identifies the plan; `attempt` re-sends the same one after a failure.
  }, [key, attempt]);

  return {
    state: panelState(plan, answer),
    retry: () => {
      setAnswer(null);
      setAttempt((value) => value + 1);
    },
  };
}
