'use client';

import { useEffect, useId, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, PRIMARY_BUTTON } from '../auth/button-classes';
import type { LanguageOption } from '../auth/language-menu';
import {
  ONBOARDING_CURRENCIES,
  currencySymbol,
  formatMinorUnits,
  minorDigits,
  type OnboardingCurrency,
} from '../../lib/money-format';
import { StepHeading } from './onboarding-shell';

/**
 * The board's sample amount, 1,250,000 in MAJOR units. Display only, never a
 * balance. It is scaled to each currency's minor units below rather than
 * written as one minor-unit constant: 125,000,000 kobo is 1,250,000 naira, but
 * 125,000,000 CFA francs is 125 million, because XOF has no minor unit.
 */
const PREVIEW_MAJOR_UNITS = 1_250_000n;

function previewMinorUnits(currency: OnboardingCurrency): bigint {
  return PREVIEW_MAJOR_UNITS * 10n ** BigInt(minorDigits(currency));
}

const PRESSABLE =
  'min-h-touch rounded-md px-3 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * `P01/5.2` — currency and language.
 *
 * The preview is formatted by `Intl` for the chosen currency; no symbol is
 * typed anywhere in this app. Customer languages are labelled with their
 * ENDONYMS from `localeLabel()`, passed in by the server, with `lang` set on
 * each chip so the browser shapes the name in its own language.
 */
export function CurrencyStep({
  t,
  currency,
  onCurrency,
  teamLanguages,
  teamLanguage,
  onTeamLanguage,
  customerLanguages,
  chosenCustomerLanguages,
  onToggleCustomerLanguage,
}: {
  t: Translator;
  currency: OnboardingCurrency;
  onCurrency: (next: OnboardingCurrency) => void;
  teamLanguages: readonly LanguageOption[];
  teamLanguage: string;
  onTeamLanguage: (code: string) => void;
  customerLanguages: readonly LanguageOption[];
  chosenCustomerLanguages: ReadonlySet<string>;
  onToggleCustomerLanguage: (code: string) => void;
}) {
  const id = useId();
  const [zone, setZone] = useState<{ name: string; short: string } | null>(null);

  // The browser knows the zone; the server does not. Read after mount so the
  // server-rendered HTML and the first client render agree.
  useEffect(() => {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const short =
      new Intl.DateTimeFormat(t.locale, { timeZone: name, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? '';
    setZone({ name, short });
  }, [t.locale]);

  return (
    <>
      <StepHeading title={t.t('currency.title')} subtitle={t.t('currency.subtitle')} />

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="mb-2 text-body-sm font-semibold">{t.t('currency.legend')}</legend>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
          {ONBOARDING_CURRENCIES.map((entry) => {
            const pressed = entry.code === currency.code;
            return (
              <button
                key={entry.code}
                type="button"
                aria-pressed={pressed}
                data-currency={entry.code}
                onClick={() => onCurrency(entry)}
                className={`${PRESSABLE} flex flex-col items-center justify-center gap-1 py-2 ${
                  pressed ? 'border-2 border-primary bg-primary-soft' : 'border border-border-strong bg-surface'
                }`}
              >
                <strong className="text-body-lg">{currencySymbol(entry)}</strong>
                <span className="font-mono text-caption text-text-2">{entry.code}</span>
              </button>
            );
          })}
        </div>
        <p aria-live="polite" data-testid="currency-preview" className="text-body-sm text-text-2">
          {t.t('currency.preview', { sample: formatMinorUnits(previewMinorUnits(currency), currency) })}
        </p>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-body-sm font-semibold">{t.t('currency.teamLanguage')}</span>
          <select
            value={teamLanguage}
            onChange={(event) => onTeamLanguage(event.target.value)}
            aria-describedby={`${id}-team-help`}
            className={FIELD}
          >
            {teamLanguages.map((option) => (
              <option key={option.code} value={option.code} lang={option.code}>
                {option.label}
              </option>
            ))}
          </select>
          <span id={`${id}-team-help`} className="text-caption text-text-muted">
            {t.t('currency.teamLanguage.help')}
          </span>
        </label>
        <div className="flex flex-col gap-2">
          <span id={`${id}-zone-label`} className="text-body-sm font-semibold">
            {t.t('currency.timeZone')}
          </span>
          <output
            aria-labelledby={`${id}-zone-label`}
            data-testid="time-zone"
            className="flex min-h-touch items-center justify-between rounded-md border border-border bg-surface-sunken px-3 text-body-md"
          >
            {zone === null ? (
              <span className="text-text-muted">{t.t('currency.timeZone.detecting')}</span>
            ) : (
              <>
                <span>{zone.name}</span>
                <span className="font-mono text-body-sm text-text-2">{zone.short}</span>
              </>
            )}
          </output>
          <span className="text-caption text-text-muted">{t.t('currency.timeZone.help')}</span>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-body-sm font-semibold">{t.t('currency.customerLanguages')}</legend>
        <div className="flex flex-wrap gap-2">
          {customerLanguages.map((option) => {
            const pressed = chosenCustomerLanguages.has(option.code);
            return (
              <button
                key={option.code}
                type="button"
                lang={option.code}
                aria-pressed={pressed}
                onClick={() => onToggleCustomerLanguage(option.code)}
                className={`${PRESSABLE} inline-flex items-center gap-1 rounded-full ${
                  pressed ? 'border border-primary bg-primary-soft text-primary-text' : 'border border-border-strong bg-surface'
                }`}
              >
                {pressed ? <Icon name="check" size="sm" /> : null}
                {option.label}
              </button>
            );
          })}
        </div>
        <span className="text-caption text-text-muted">{t.t('currency.customerLanguages.help')}</span>
      </fieldset>
    </>
  );
}

/**
 * `P01/5.3` — connect WhatsApp Business.
 *
 * NO PRICE IS PRINTED, IN ANY LANGUAGE. Meta sets prices per country and
 * changes them; the board explains the cost TYPES and the 24-hour window,
 * which is the part still true next quarter. An acceptance test scans every
 * catalogue's `whatsapp` keys for a currency amount.
 *
 * Meta embedded sign-up is M8's (T-0017). The button is wired to say so, rather
 * than to open a window that cannot finish.
 */
export function WhatsAppStep({ t }: { t: Translator }) {
  const [unavailable, setUnavailable] = useState(false);

  const costs = [
    ['whatsapp.cost.service', 'whatsapp.cost.level.free', 'text-success-text'],
    ['whatsapp.cost.utility', 'whatsapp.cost.level.low', 'text-text'],
    ['whatsapp.cost.auth', 'whatsapp.cost.level.low', 'text-text'],
    ['whatsapp.cost.marketing', 'whatsapp.cost.level.highest', 'text-warning-text'],
  ] as const;

  return (
    <>
      <StepHeading title={t.t('whatsapp.title')} subtitle={t.t('whatsapp.subtitle')} />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <strong className="text-body-md">{t.t('whatsapp.need.title')}</strong>
        <ul className="flex list-none flex-col gap-2 p-0 text-body-sm text-text-2">
          <li className="flex gap-2">
            <Icon name="smartphone" size="sm" className="text-primary-text" />
            {t.t('whatsapp.need.number')}
          </li>
          <li className="flex gap-2">
            <Icon name="domain" size="sm" className="text-primary-text" />
            {t.t('whatsapp.need.meta')}
          </li>
          <li className="flex gap-2">
            <Icon name="description" size="sm" className="text-primary-text" />
            {t.t('whatsapp.need.registration')}
          </li>
        </ul>
      </div>

      <button
        type="button"
        data-testid="whatsapp-connect"
        onClick={() => setUnavailable(true)}
        className={PRIMARY_BUTTON}
      >
        <Icon name="open_in_new" size="sm" />
        {t.t('whatsapp.connect')}
      </button>
      <p className="text-caption text-text-muted">{t.t('whatsapp.connect.note')}</p>
      {unavailable ? (
        <p role="status" data-testid="whatsapp-unavailable" className="rounded-lg bg-info-soft p-3 text-body-sm text-info-text">
          {t.t('whatsapp.connect.unavailable')}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <strong className="flex items-center gap-2 text-body-md">
          <Icon name="schedule" size="sm" />
          {t.t('whatsapp.window.title')}
        </strong>
        <p className="text-body-sm text-text-2">{t.t('whatsapp.window.body')}</p>
        <div aria-hidden="true" className="flex flex-col gap-1">
          <div className="flex h-2 overflow-hidden rounded-full">
            <span className="flex-[2] bg-success" />
            <span className="flex-1 bg-border-strong" />
          </div>
          <div className="flex justify-between font-mono text-caption text-text-muted">
            <span>{t.t('whatsapp.window.start')}</span>
            <span>{t.t('whatsapp.window.mark')}</span>
            <span>{t.t('whatsapp.window.end')}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
        <strong className="flex items-center gap-2 text-body-md">
          <Icon name="payments" size="sm" />
          {t.t('whatsapp.cost.title')}
        </strong>
        <dl data-testid="whatsapp-costs" className="m-0 flex flex-col">
          {costs.map(([label, level, tone]) => (
            <div key={label} className="flex justify-between gap-3 border-b border-border py-2 text-body-sm">
              <dt>{t.t(label)}</dt>
              <dd className={`m-0 font-bold ${tone}`}>{t.t(level)}</dd>
            </div>
          ))}
        </dl>
        <p className="pt-2 text-caption text-text-muted">{t.t('whatsapp.cost.note')}</p>
      </div>
    </>
  );
}
