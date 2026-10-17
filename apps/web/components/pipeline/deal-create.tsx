'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { minorDigits, parseMajorAmount } from '../../lib/deal-money';
import { DEAL_CURRENCIES, createDeal, isDealCurrency, type CreateDealBody } from '../../lib/pipelines-api';
import { errorMessage } from './pipeline-model';
import { PipelineDialog } from './pipeline-dialog';

/**
 * New deal (T-0109, R7): one createDeal, in the pipeline's first open stage,
 * the caller as owner. It sends the name and ONLY the optional fields filled:
 * never `null` for an empty one, never `ownerUserId`, a programme, a pipeline
 * or a stage.
 *
 * MONEY IS TYPED IN MAJOR UNITS, IN A TEXT INPUT. A number input cannot hold
 * eighteen significant digits faithfully; the text is turned into DealMoney's
 * minor-unit string by string arithmetic (`lib/deal-money.ts`), with "." as
 * the decimal point and at most the currency's minor digits. Anything else is
 * a translated field error here, and nothing is sent.
 *
 * A field the board says is withheld is not offered. A refusal is a
 * translated alert, and the form keeps what was typed (D-L84).
 */

type FieldName = 'name' | 'amount' | 'currency';

export function DealCreate({
  t,
  pipelineId,
  withheldFields,
  online,
  onClose,
  onCreated,
  onOrphanRefusal,
}: {
  t: Translator;
  pipelineId: string;
  withheldFields: readonly string[];
  online: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** A refusal that arrives after the form was closed: said by the screen, never dropped. */
  onOrphanRefusal: (text: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [errors, setErrors] = useState<ReadonlySet<FieldName>>(() => new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ids = { name: useId(), amount: useId(), currency: useId(), close: useId(), next: useId() };

  const offersAmount = !withheldFields.includes('amount');
  const offersClose = !withheldFields.includes('expectedCloseDate');
  const offersNext = !withheldFields.includes('nextStep');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending || !navigator.onLine) return;
    const found = new Set<FieldName>();
    const body: { -readonly [K in keyof CreateDealBody]: CreateDealBody[K] } = { name: name.trim() };
    if (body.name === '') found.add('name');
    if (offersAmount && amount.trim() !== '') {
      const minor = parseMajorAmount(amount, isDealCurrency(currency) ? minorDigits(currency) : 2);
      if (minor === null) found.add('amount');
      if (!isDealCurrency(currency)) found.add('currency');
      if (minor !== null && isDealCurrency(currency)) body.amount = { amountMinor: minor, currency };
    }
    if (offersClose && closeDate !== '') body.expectedCloseDate = closeDate;
    if (offersNext && nextStep.trim() !== '') body.nextStep = nextStep.trim();
    setErrors(found);
    if (found.size > 0) return;
    setSending(true);
    setRefusal(null);
    const result = await createDeal(pipelineId, body);
    if (result.ok) {
      onCreated();
      if (mounted.current) setSending(false);
      return;
    }
    const text = t.t(errorMessage(result.error));
    if (!mounted.current) {
      onOrphanRefusal(text);
      return;
    }
    setSending(false);
    setRefusal(text);
  };

  const fieldError = (field: FieldName, message: Parameters<Translator['t']>[0]) =>
    errors.has(field) ? (
      <p data-field-error={field} className="text-body-sm text-danger-text">
        {t.t(message)}
      </p>
    ) : null;

  const label = 'flex flex-col gap-1 text-body-sm font-semibold';
  return (
    <PipelineDialog
      testId="deal-create"
      title={t.t('pipeline.create.title')}
      closeLabel={t.t('pipeline.dialog.close')}
      busy={sending}
      onClose={onClose}
    >
      <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <p className="text-body-sm text-text-2">{t.t('pipeline.create.intro')}</p>
        <div className={label}>
          <label htmlFor={ids.name}>{t.t('pipeline.field.name')}</label>
          <input
            id={ids.name}
            type="text"
            data-field-input="name"
            maxLength={200}
            autoComplete="off"
            aria-invalid={errors.has('name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={`${FIELD} font-normal`}
          />
          {fieldError('name', 'pipeline.create.error.name')}
        </div>
        {offersAmount ? (
          <div className="flex flex-wrap gap-3">
            <div className={`${label} min-w-0 flex-1`}>
              <label htmlFor={ids.amount}>{t.t('pipeline.field.amount')}</label>
              <input
                id={ids.amount}
                type="text"
                inputMode="decimal"
                data-field-input="amount"
                autoComplete="off"
                aria-invalid={errors.has('amount')}
                aria-describedby={`${ids.amount}-hint`}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className={`${FIELD} font-normal`}
              />
              <span id={`${ids.amount}-hint`} className="text-caption font-normal text-text-2">
                {t.t('pipeline.create.amountHint')}
              </span>
              {fieldError('amount', 'pipeline.create.error.amount')}
            </div>
            <div className={label}>
              <label htmlFor={ids.currency}>{t.t('pipeline.field.currency')}</label>
              <select
                id={ids.currency}
                data-field-input="currency"
                aria-invalid={errors.has('currency')}
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                className={`${FIELD} font-normal`}
              >
                <option value="">{t.t('pipeline.create.currency.choose')}</option>
                {DEAL_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
              {fieldError('currency', 'pipeline.create.error.currency')}
            </div>
          </div>
        ) : null}
        {offersClose ? (
          <div className={label}>
            <label htmlFor={ids.close}>{t.t('pipeline.field.expectedCloseDate')}</label>
            <input
              id={ids.close}
              type="date"
              data-field-input="expectedCloseDate"
              value={closeDate}
              onChange={(event) => setCloseDate(event.target.value)}
              className={`${FIELD} font-normal`}
            />
          </div>
        ) : null}
        {offersNext ? (
          <div className={label}>
            <label htmlFor={ids.next}>{t.t('pipeline.field.nextStep')}</label>
            <input
              id={ids.next}
              type="text"
              data-field-input="nextStep"
              maxLength={200}
              autoComplete="off"
              value={nextStep}
              onChange={(event) => setNextStep(event.target.value)}
              className={`${FIELD} font-normal`}
            />
          </div>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
            <Icon name="error" size="sm" />
            <span>{refusal}</span>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={sending} onClick={onClose} className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}>
            {t.t('pipeline.cancel')}
          </button>
          <button
            type="submit"
            data-action="create-deal"
            data-requires-connection=""
            disabled={!online || sending}
            className={`${PRIMARY_BUTTON} disabled:cursor-not-allowed`}
          >
            {t.t('pipeline.create.submit')}
          </button>
        </div>
      </form>
    </PipelineDialog>
  );
}
