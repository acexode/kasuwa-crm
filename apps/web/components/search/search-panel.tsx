'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { QUIET_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import type { RecordsError } from '../../lib/records-api';
import {
  hitHref,
  personName,
  seeAllHref,
  type SearchGroup,
  type SearchHit,
  type SearchType,
} from '../../lib/search-api';
import { groupLabel, seeAllLabel } from './message-ids';
import { useSearch, type PanelState } from './use-search';

/**
 * The P27 search panel (T-0087): the box, its grouped hits and its states,
 * drawn inline on `/search` (A1, A2, A4, A5) and inside the command palette
 * (D1's record rows). One panel, one client, so the two cannot drift.
 *
 * ---------------------------------------------------------------------------
 * THE ARIA 1.2 COMBOBOX (R6). The input is `role="combobox"` and keeps focus
 * while ArrowDown and ArrowUp move `aria-activedescendant` over the options in
 * DOM order; Enter opens the active one. The listbox is drawn only when there
 * is something in it (an empty listbox is not a listbox), each group is a
 * `role="group"` named by its translated type label, and each hit is an
 * `option` with an id of its own: a lead is in the contact AND the lead group,
 * so ids come from the group and the position, never from the record.
 *
 * NO COUNTS (D-P13). At most three hits per group, in the order served; no
 * total, "more" or estimate anywhere. "See all" goes to the type's own list
 * with exactly the `q` searched (R8), for every answered NAME query, an empty
 * one included, and never for a lookup: that would put a phone number in a
 * URL. Deals have no list.
 *
 * ONLY WHAT IS SERVED (R14, R15). `displayName` as served, never composed;
 * when it is withheld, one readable name part; with none, a lock and a neutral
 * label, never the id. A hit links only from a well-formed uuid. Record text
 * is text: React escapes it, and nothing here sets inner HTML.
 *
 * FOUR STATES, KEPT APART (R16): loading, no matches, failed and refused. A
 * number being typed is none of them: it gets the neutral "keep typing" hint
 * (R27). Nothing typed, or too little, draws nothing at all — and there are no
 * recent searches to draw (R19).
 * ---------------------------------------------------------------------------
 */

const HIT_ICON: Readonly<Record<SearchType, IconName>> = {
  contact: 'person',
  lead: 'campaign',
  account: 'domain',
  deal: 'handshake',
};

const HIT_TINT: Readonly<Record<SearchType, string>> = {
  contact: 'bg-info-soft text-info-text',
  lead: 'bg-accent-soft text-accent-text',
  account: 'bg-primary-soft text-primary-text',
  deal: 'bg-success-soft text-success-text',
};

const SEE_ALL_TYPES = ['contact', 'lead', 'account'] as const;

interface Option {
  readonly id: string;
  readonly type: SearchType;
  readonly hit: SearchHit;
  readonly href: string | null;
}

function optionsOf(baseId: string, groups: readonly SearchGroup[], dealsLive: boolean): Option[] {
  return groups.flatMap((group) =>
    group.hits.map((hit, index) => ({
      id: `${baseId}-${group.type}-${index}`,
      type: group.type,
      hit,
      href: hitHref(group.type, hit.id, dealsLive),
    })),
  );
}

function HitBody({ option, t }: { option: Option; t: Translator }) {
  const { hit, type } = option;
  const name = hit.kind === 'person' ? personName(hit) : hit.name;
  const company =
    hit.kind === 'person' && typeof hit.companyName === 'string' && hit.companyName.trim() !== '' && hit.companyName !== name
      ? hit.companyName
      : null;
  return (
    <>
      <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${HIT_TINT[type]}`}>
        <Icon name={HIT_ICON[type]} size="sm" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {name === null ? (
          <span data-field="name" data-locked="true" className="flex min-w-0 items-center gap-1 text-body-md text-text-2">
            <Icon name="lock" size="sm" />
            <span className="truncate">{t.t('search.hit.nameWithheld')}</span>
          </span>
        ) : (
          <span data-field="name" data-record-text="" className="truncate text-body-md font-semibold text-text">
            {name}
          </span>
        )}
        {company === null ? null : (
          <span data-field="company" data-record-text="" className="truncate text-body-sm text-text-2">
            {company}
          </span>
        )}
      </span>
    </>
  );
}

function StateMessage({ state, t }: { state: PanelState; t: Translator }) {
  switch (state.kind) {
    case 'keepTyping':
      return (
        <p data-testid="search-hint" className="flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-body-sm text-text-2">
          <Icon name="info" size="sm" />
          {t.t('search.keepTyping')}
        </p>
      );
    case 'invalid':
      return (
        <p
          data-testid="search-invalid"
          data-field={state.field}
          className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft p-3 text-body-sm text-warning-text"
        >
          <Icon name="warning" size="sm" />
          {t.t(state.field === 'phone' ? 'search.invalidPhone' : 'search.invalidEmail')}
        </p>
      );
    case 'loading':
      return (
        <div data-testid="search-loading" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">{t.t('search.loading')}</span>
          {[0, 1, 2].map((row) => (
            <div key={row} aria-hidden="true" className="flex items-center gap-3 py-1">
              <span className="h-9 w-9 shrink-0 rounded-md bg-surface-sunken" />
              <span className="flex flex-1 flex-col gap-1">
                <span className="h-4 w-40 max-w-full rounded-sm bg-surface-sunken" />
                <span className="h-3 w-24 rounded-sm bg-surface-sunken" />
              </span>
            </div>
          ))}
        </div>
      );
    case 'results':
      if (state.groups.some((group) => group.hits.length > 0)) return null;
      return (
        <div data-testid="search-empty" className="flex flex-col items-start gap-1 py-2">
          <p className="flex items-center gap-2 text-body-md font-bold text-text">
            <Icon name="search_off" size="sm" />
            {t.t('search.empty.title')}
          </p>
          <p className="text-body-sm text-text-2">{t.t('search.empty.body')}</p>
        </div>
      );
    default:
      return null;
  }
}

/**
 * A failed read: never "no matches", and said for what it is (D-L137 M5). A
 * throttled search says to wait, and its Retry stays off until the
 * contract's `retryAt` has passed; a refusal the screen did not expect says
 * the request was not accepted; a lost session says to sign in; anything
 * else is the connection.
 */
function errorCopy(error: RecordsError): MessageId {
  switch (error.code) {
    case 'too_many_requests':
      return 'records.error.too_many_requests';
    case 'validation_failed':
      return 'records.error.validation_failed';
    case 'not_authenticated':
      return 'records.error.not_authenticated';
    default:
      return 'search.error.body';
  }
}

function SearchError({ error, t, onRetry }: { error: RecordsError; t: Translator; onRetry: () => void }) {
  const waitUntil = error.code === 'too_many_requests' && error.retryAt !== undefined ? Date.parse(error.retryAt) : Number.NaN;
  const [waiting, setWaiting] = useState(() => Number.isFinite(waitUntil) && waitUntil > Date.now());
  useEffect(() => {
    if (!Number.isFinite(waitUntil)) return undefined;
    const left = waitUntil - Date.now();
    if (left <= 0) {
      setWaiting(false);
      return undefined;
    }
    setWaiting(true);
    const timer = window.setTimeout(() => setWaiting(false), left);
    return () => window.clearTimeout(timer);
  }, [waitUntil]);
  return (
    <div
      role="alert"
      data-testid="search-error"
      data-error-code={error.code}
      className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-soft p-3 text-body-sm text-danger-text"
    >
      <p className="flex items-center gap-2 font-bold">
        <Icon name="error" size="sm" />
        {t.t('search.error.title')}
      </p>
      <p>{t.t(errorCopy(error))}</p>
      <button type="button" onClick={onRetry} disabled={waiting} className={`${QUIET_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}>
        {t.t('records.retry')}
      </button>
    </div>
  );
}

export function SearchPanel({
  t,
  initialText = '',
  autoFocus = false,
  onNavigate,
  footer,
  dealsLive = false,
}: {
  t: Translator;
  /** A name the page was asked to search for (never an identifier: `nameFromUrl`). */
  initialText?: string;
  autoFocus?: boolean;
  /** Called when a hit or a list is opened, before the navigation (the palette closes). */
  onNavigate?: () => void;
  /** The deal screen answers in this process (`crmLiveNav()` lists `deals`): deal hits link to it (D-L137). */
  dealsLive?: boolean;
  footer?: ReactNode;
}) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-results`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialText);
  const [active, setActive] = useState(-1);
  const { state, retry } = useSearch(text);

  const groups = state.kind === 'results' ? state.groups.filter((group) => group.hits.length > 0) : [];
  const options = optionsOf(baseId, groups, dealsLive);
  const expanded = options.length > 0;
  const activeOption = active >= 0 ? options[active] : undefined;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // A new answer (or a new query) starts with nothing active.
  const signature = options.map((option) => option.id + option.hit.id).join('|');
  useEffect(() => {
    setActive(-1);
  }, [signature]);

  const open = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => {
        if (current < 0) return step === 1 ? 0 : options.length - 1;
        return (current + step + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter' && activeOption !== undefined) {
      event.preventDefault();
      if (activeOption.href !== null) open(activeOption.href);
    }
  };

  // Keep the active option in view as the arrows move it.
  useEffect(() => {
    if (activeOption === undefined) return;
    document.getElementById(activeOption.id)?.scrollIntoView({ block: 'nearest' });
  }, [activeOption]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-touch min-w-0 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        <Icon name="search" size="sm" className="text-text-muted" />
        <input
          ref={inputRef}
          data-testid="search-input"
          type="text"
          role="combobox"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          aria-label={t.t('search.input.label')}
          placeholder={t.t('search.input.placeholder')}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-activedescendant={activeOption?.id}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-touch min-w-0 flex-1 bg-transparent text-body-md text-text placeholder:text-text-muted focus:outline-none"
        />
      </div>

      <div role="status" aria-live="polite">
        <StateMessage state={state} t={t} />
        {/* How many hits are DRAWN, for screen readers only (D-L137 L5): never a total, a "more" or anything hidden. */}
        {expanded ? (
          <span data-search-announcement="" className="sr-only">
            {t.t('search.results.count', { count: options.length })}
          </span>
        ) : null}
      </div>

      {state.kind === 'error' ? <SearchError error={state.error} t={t} onRetry={retry} /> : null}

      {expanded ? (
        <div role="listbox" id={listboxId} aria-label={t.t('search.results.label')} className="flex min-w-0 flex-col gap-3">
          {groups.map((group) => {
            const labelId = `${baseId}-${group.type}-label`;
            return (
              <div key={group.type} role="group" aria-labelledby={labelId} data-group={group.type} className="flex min-w-0 flex-col">
                <div id={labelId} role="presentation" className="px-2 pb-1 text-caption font-bold uppercase text-text-muted">
                  {t.t(groupLabel(group.type))}
                </div>
                {options
                  .filter((option) => option.type === group.type)
                  .map((option) => {
                    const selected = activeOption?.id === option.id;
                    const className = `flex min-h-touch min-w-0 items-center gap-3 rounded-md px-2 py-1 ${
                      selected ? 'bg-primary-soft' : 'hover:bg-surface-sunken'
                    } ${FOCUS}`;
                    return option.href === null ? (
                      <div
                        key={option.id}
                        id={option.id}
                        role="option"
                        aria-selected={selected}
                        data-hit={option.hit.id}
                        data-hit-type={option.type}
                        className={className}
                      >
                        <HitBody option={option} t={t} />
                      </div>
                    ) : (
                      <Link
                        key={option.id}
                        id={option.id}
                        role="option"
                        aria-selected={selected}
                        tabIndex={-1}
                        href={option.href}
                        prefetch={false}
                        onClick={() => onNavigate?.()}
                        data-hit={option.hit.id}
                        data-hit-type={option.type}
                        className={className}
                      >
                        <HitBody option={option} t={t} />
                      </Link>
                    );
                  })}
              </div>
            );
          })}
        </div>
      ) : null}

      {state.kind === 'results' && state.q !== null ? (
        <div className="flex min-w-0 flex-wrap gap-x-2">
          {SEE_ALL_TYPES.map((type) => {
            const href = seeAllHref(type, state.q ?? '');
            return href === null ? null : (
              <Link
                key={type}
                href={href}
                prefetch={false}
                data-see-all={type}
                onClick={() => onNavigate?.()}
                className={`${QUIET_BUTTON} min-w-0`}
              >
                <span className="truncate">{t.t(seeAllLabel(type))}</span>
                <Icon name="arrow_forward" size="sm" />
              </Link>
            );
          })}
        </div>
      ) : null}

      {footer}
    </div>
  );
}
