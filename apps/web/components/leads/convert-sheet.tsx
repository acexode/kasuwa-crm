'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from '../admin/dialog';
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import { FOCUS, MENU_ROW } from '../records/list-classes';
import { CheckMark } from '../records/list-parts';
import { SEARCH_DEBOUNCE_MS } from '../records/use-keyset-list';
import { listAccounts, type Account } from '../../lib/accounts-api';
import { convertLead, type ConvertLeadBody, type ConvertLeadResult, type Lead } from '../../lib/leads-api';
import type { RecordsError } from '../../lib/records-api';
import {
  NEW_ACCOUNT_NAME_MAX,
  convertAttempt,
  convertInDoubt,
  convertRefusal,
  pickableAccounts,
  suggestedAccountName,
  type ConvertMode,
} from './leads-model';

/**
 * Convert a lead (P04/01's row action, T-0058, D-P17, D-L86): qualify it and
 * link it to an account, in ONE `convertContact` — never createAccount then
 * link, which would be two transactions and two audit events.
 *
 *   - AN EXISTING ACCOUNT is picked by NAME from `listAccounts`, filtered to
 *     the LEAD'S programme: an account in another programme is a 404, even
 *     when the caller reaches both (listAccounts: filter client-side on
 *     `programmeId`). The id is the option's hook and is never printed.
 *   - A NEW ACCOUNT is a name, prefilled from a readable `companyName`.
 *   - A REFUSAL (403, 409, 404, 400) is a translated `role=alert` in the
 *     sheet, which stays open with what was chosen. `already_linked` has its
 *     own sentence. A 409 re-reads the lead, so the next press is not blind.
 *   - A LOST ANSWER is not a refusal: the server may have converted it. The
 *     sheet says so, LOCKS every choice, and the next press re-sends the
 *     exact body that was lost, which the contract answers 200 as an exact
 *     repeat — one account, one event. The lock lifts on a definitive answer;
 *     closing the sheet forgets it.
 *   - CONVERT IS ONCE. While a request is in flight the button is
 *     `aria-disabled` (not `disabled`, which would drop keyboard focus) and a
 *     second press does nothing. OFFLINE it is off (D-P21: no offline queue).
 */

interface Search {
  readonly phase: 'idle' | 'loading' | 'loaded' | 'error';
  readonly accounts: readonly Account[];
  readonly error: RecordsError | null;
}

const IDLE: Search = { phase: 'idle', accounts: [], error: null };

/** The picker's page: P04 offers 25, 50 and 100. The picker filters by programme after the read. */
const PICKER_LIMIT = 50;

export function ConvertSheet({
  t,
  lead,
  online,
  onClose,
  onConverted,
  onStale,
}: {
  t: Translator;
  lead: Lead;
  online: boolean;
  onClose: () => void;
  onConverted: (result: ConvertLeadResult) => void;
  /** A 409: the parent reads the lead again, and passes the fresh row back in. */
  onStale: (id: string) => void;
}) {
  const [mode, setMode] = useState<ConvertMode>('existing');
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState<Search>(IDLE);
  const [picked, setPicked] = useState<Account | null>(null);
  const [name, setName] = useState(() => suggestedAccountName(lead));
  const [invalid, setInvalid] = useState<MessageId | null>(null);
  const [refusal, setRefusal] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState(false);
  // The body whose answer was lost, if any. While it is held, every choice is
  // locked and the next press re-sends it unchanged (D-L86).
  const [lost, setLost] = useState<ConvertLeadBody | null>(null);
  const held = lost !== null;
  const sequence = useRef(0);
  const formId = useId();
  const blocked = busy || !online;
  const { programmeId } = lead;

  // The picker reads as the person types, after a pause; only the latest
  // answer is applied. The search term never enters the URL.
  useEffect(() => {
    const trimmed = term.trim();
    sequence.current += 1;
    const mine = sequence.current;
    if (mode !== 'existing' || trimmed === '') {
      setSearch(IDLE);
      return undefined;
    }
    setSearch((current) => ({ ...current, phase: 'loading', error: null }));
    const timer = setTimeout(() => {
      void listAccounts({ q: trimmed, limit: PICKER_LIMIT }).then((result) => {
        if (sequence.current !== mine) return;
        setSearch(
          result.ok
            ? { phase: 'loaded', accounts: pickableAccounts(result.value.data, programmeId), error: null }
            : { phase: 'error', accounts: [], error: result.error },
        );
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, mode, programmeId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked) return;
    setRefusal(null);
    const checked = convertAttempt(lost, lead, { mode, accountId: picked?.id ?? null, name });
    if (!checked.ok) {
      setInvalid(checked.invalid);
      return;
    }
    setInvalid(null);
    setBusy(true);
    const result = await convertLead(lead.id, checked.body);
    if (result.ok) {
      onConverted(result.value);
      return;
    }
    setBusy(false);
    setLost(convertInDoubt(result.error) ? checked.body : null);
    setRefusal(convertRefusal(result.error, mode));
    if (result.error.code === 'stale_write') onStale(lead.id);
  };

  return (
    <Dialog
      title={t.t('leads.convert.title')}
      icon="task_alt"
      tone="info"
      closeLabel={t.t('accounts.sheet.close')}
      onClose={onClose}
      testId="convert-sheet"
      footer={
        <>
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t.t('accounts.sheet.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            data-action="confirm-convert"
            data-requires-connection=""
            aria-disabled={blocked ? 'true' : undefined}
            className={`${PRIMARY_BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
          >
            {busy ? t.t('leads.convert.converting') : t.t('leads.convert.confirm')}
          </button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p data-record-text="" className="break-words text-body-md font-semibold">
            {lead.displayName}
          </p>
          <p className="text-body-sm text-text-2">{t.t('leads.convert.body')}</p>
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-body-sm font-semibold">{t.t('leads.convert.mode')}</legend>
          {(['existing', 'new'] as const).map((option) => (
            <label key={option} className="flex min-h-touch items-center gap-3 text-body-md">
              <input
                type="radio"
                name={`${formId}-mode`}
                value={option}
                data-convert-mode={option}
                checked={mode === option}
                disabled={held}
                onChange={() => {
                  setMode(option);
                  setInvalid(null);
                }}
                className={`h-6 w-6 shrink-0 ${FOCUS}`}
              />
              {t.t(option === 'existing' ? 'leads.convert.mode.existing' : 'leads.convert.mode.new')}
            </label>
          ))}
        </fieldset>

        {mode === 'existing' ? (
          <Picker
            t={t}
            id={`${formId}-account`}
            term={term}
            search={search}
            picked={picked}
            held={held}
            onTerm={setTerm}
            onPick={(account) => {
              setPicked(account);
              setInvalid(null);
            }}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${formId}-name`} className="text-body-sm font-semibold">
              {t.t('leads.convert.newName')}
            </label>
            <input
              id={`${formId}-name`}
              type="text"
              data-field-input="newAccount.name"
              value={name}
              maxLength={NEW_ACCOUNT_NAME_MAX}
              autoComplete="off"
              aria-required="true"
              aria-invalid={invalid === null ? undefined : 'true'}
              disabled={held}
              onChange={(event) => setName(event.target.value)}
              className={`${FIELD} w-full disabled:cursor-not-allowed disabled:bg-surface-sunken`}
            />
          </div>
        )}

        {invalid === null ? null : <p className="text-caption font-semibold text-danger-text">{t.t(invalid)}</p>}
        {refusal === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            {t.t(refusal)}
          </p>
        )}
        {online ? null : (
          <p className="flex items-start gap-2 rounded-md bg-warning-soft p-3 text-body-sm text-warning-text">
            <Icon name="cloud_off" size="sm" />
            {t.t('leads.convert.offline')}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The account picker: a search box and the lead's programme's accounts, by name. */
function Picker({
  t,
  id,
  term,
  search,
  picked,
  held,
  onTerm,
  onPick,
}: {
  t: Translator;
  id: string;
  term: string;
  search: Search;
  picked: Account | null;
  /** A lost answer is held: the choice stays as it was sent. */
  held: boolean;
  onTerm: (term: string) => void;
  onPick: (account: Account) => void;
}) {
  return (
    <div data-testid="account-picker" className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="text-body-sm font-semibold">
        {t.t('leads.convert.search.label')}
      </label>
      <input
        id={id}
        type="search"
        value={term}
        maxLength={100}
        autoComplete="off"
        disabled={held}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onTerm(event.target.value)}
        className={`${FIELD} w-full disabled:cursor-not-allowed disabled:bg-surface-sunken`}
      />
      <p id={`${id}-hint`} className="text-caption text-text-2">
        {t.t('leads.convert.search.hint')}
      </p>
      {picked === null ? null : (
        <p className="flex items-center gap-2 text-body-sm">
          <Icon name="domain" size="sm" className="text-text-muted" />
          <span>{t.t('leads.convert.picked')}</span>
          <b data-record-text="">{picked.name}</b>
        </p>
      )}
      <div aria-live="polite" className="flex flex-col">
        {search.phase === 'idle' ? (
          <p className="text-body-sm text-text-muted">{t.t('leads.convert.search.prompt')}</p>
        ) : search.phase === 'loading' ? (
          <p className="text-body-sm text-text-muted">{t.t('leads.convert.search.loading')}</p>
        ) : search.phase === 'error' ? (
          <p className="text-body-sm text-danger-text">{t.t(`records.error.${search.error?.code ?? 'network'}` as MessageId)}</p>
        ) : search.accounts.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t.t('leads.convert.search.none')}</p>
        ) : (
          <div role="group" aria-label={t.t('leads.convert.search.label')} className="flex flex-col">
            {search.accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                data-account-option={account.id}
                aria-pressed={picked?.id === account.id}
                disabled={held}
                onClick={() => onPick(account)}
                className={`${MENU_ROW} ${picked?.id === account.id ? 'font-semibold text-primary-text' : 'text-text'}`}
              >
                <CheckMark on={picked?.id === account.id} />
                <span data-record-text="" className="min-w-0 break-words">
                  {account.name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
