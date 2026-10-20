'use client';

import { useEffect, useId, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Chip, Select } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import {
  ONBOARDING_CURRENCIES,
  currencySymbol,
  formatMinorUnits,
  minorDigits,
  type OnboardingCurrency,
} from '../../lib/money-format';
import { StepHeading } from './onboarding-shell';
import { zoneNameLocale } from '../../lib/retry-time';

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

/**
 * A translated sentence with a money amount set in the MONO face.
 *
 * Measured, not stylistic. The naira and cedi signs (U+20A6, U+20B5) fall in
 * the Latin Extended `unicode-range`, and Noto Sans's Latin Extended file is
 * 168 KB — drawing one naira sign in the body face downloaded more than half
 * the PRD 2.13 page budget (`/onboarding` measured 399,576 bytes). JetBrains
 * Mono's file for the same range is 11.6 KB, and the board already sets
 * figures in mono. The sentence is split on a sentinel rather than built from
 * fragments, so each language keeps its own word order around the amount.
 */
const AMOUNT_SENTINEL = '\u0000';

function MoneySentence({ sentence, amount }: { sentence: (sample: string) => string; amount: string }) {
  const [before = '', after = ''] = sentence(AMOUNT_SENTINEL).split(AMOUNT_SENTINEL);
  return (
    <>
      {before}
      <strong dir="ltr" className="font-mono text-text">
        {amount}
      </strong>
      {after}
    </>
  );
}

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
  const [zone, setZone] = useState<{ name: string; city: string; short: string } | null>(null);

  // The browser knows the zone; the server does not. Read after mount so the
  // server-rendered HTML and the first client render agree.
  useEffect(() => {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const short =
      new Intl.DateTimeFormat(zoneNameLocale(t.locale), { timeZone: name, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? '';
    // "Africa/Lagos" -> "Lagos": the city, as the board shows it.
    const city = (name.split('/').pop() ?? name).replace(/_/g, ' ');
    setZone({ name, city, short });
  }, [t.locale]);

  return (
    <>
      <StepHeading title={t.t('currency.title')} subtitle={t.t('currency.subtitle')} />

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mb-2.5 p-0 text-body-sm font-semibold">{t.t('currency.legend')}</legend>
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
                className={`flex h-14 flex-col items-center justify-center gap-px rounded-10 text-text focus-visible:ring-focus ${
                  pressed ? 'border-2 border-primary bg-primary-soft' : 'border border-border-strong bg-surface hover:bg-surface-sunken'
                }`}
              >
                <strong className="text-body-md font-bold">{currencySymbol(entry)}</strong>
                <span className="text-caption font-normal text-text-2">{entry.code}</span>
              </button>
            );
          })}
        </div>
        <p
          aria-live="polite"
          data-testid="currency-preview"
          className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2.5 text-body-sm"
        >
          <span>
            <MoneySentence
              sentence={(sample) => t.t('currency.preview', { sample })}
              amount={formatMinorUnits(previewMinorUnits(currency), currency)}
            />
          </span>
        </p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          size="large"
          label={t.t('currency.teamLanguage')}
          hint={t.t('currency.teamLanguage.help')}
          value={teamLanguage}
          onChange={(event) => onTeamLanguage(event.target.value)}
        >
          {teamLanguages.map((option) => (
            <option key={option.code} value={option.code} lang={option.code}>
              {option.label}
            </option>
          ))}
        </Select>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span id={`${id}-zone-label`} className="text-body-sm font-semibold">
            {t.t('currency.timeZone')}
          </span>
          {/* Read from the browser and shown as the export draws it: the city,
              then the zone's letters in a pill. */}
          <output
            aria-labelledby={`${id}-zone-label`}
            data-testid="time-zone"
            className="flex h-control-lg items-center gap-2 rounded-md border border-border-strong bg-surface pe-3 ps-3.5 text-body-md"
          >
            {zone === null ? (
              <span className="text-text-muted">{t.t('currency.timeZone.detecting')}</span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate" title={zone.name}>
                  {zone.city}
                </span>
                <span className="rounded-sm bg-primary-soft px-2 py-0.5 text-caption font-bold text-primary-text">
                  {zone.short}
                </span>
              </>
            )}
          </output>
          <span className="text-meta text-text-muted">{t.t('currency.timeZone.help')}</span>
        </div>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-body-sm font-semibold">{t.t('currency.customerLanguages')}</legend>
        <div className="flex flex-wrap gap-2">
          {customerLanguages.map((option) => {
            const pressed = chosenCustomerLanguages.has(option.code);
            return (
              <Chip
                key={option.code}
                variant="choice"
                lang={option.code}
                active={pressed}
                aria-pressed={pressed}
                {...(pressed ? { icon: 'check' as const } : {})}
                onClick={() => onToggleCustomerLanguage(option.code)}
              >
                {option.label}
              </Chip>
            );
          })}
        </div>
        <span className="text-meta text-text-muted">{t.t('currency.customerLanguages.help')}</span>
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
    ['whatsapp.cost.marketing', 'whatsapp.cost.level.highest', 'text-text'],
  ] as const;

  return (
    <>
      <StepHeading title={t.t('whatsapp.title')} subtitle={t.t('whatsapp.subtitle')} />

      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-4">
        <strong className="text-label font-bold">{t.t('whatsapp.need.title')}</strong>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-body-sm text-text-2">
          <li className="flex gap-2.5">
            <Icon name="smartphone" size={20} className="text-text" />
            {t.t('whatsapp.need.number')}
          </li>
          <li className="flex gap-2.5">
            <Icon name="business_center" size={20} className="text-text" />
            {t.t('whatsapp.need.meta')}
          </li>
          <li className="flex gap-2.5">
            <Icon name="description" size={20} className="text-text" />
            {t.t('whatsapp.need.registration')}
          </li>
        </ul>
      </div>

      <button
        type="button"
        data-testid="whatsapp-connect"
        onClick={() => setUnavailable(true)}
        className="flex h-control-xl items-center justify-center gap-2 rounded-10 bg-primary px-4 text-body-md font-bold text-on-primary hover:bg-primary-hover focus-visible:ring-focus"
      >
        <Icon name="open_in_new" size={22} />
        {t.t('whatsapp.connect')}
      </button>
      <p className="-mt-2 text-center text-meta text-text-muted">{t.t('whatsapp.connect.note')}</p>
      {unavailable ? (
        <p
          role="status"
          data-testid="whatsapp-unavailable"
          className="rounded-10 bg-info-soft px-3.5 py-3 text-body-sm text-info-text"
        >
          {t.t('whatsapp.connect.unavailable')}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-4">
        <strong className="flex items-center gap-2 text-label font-bold">
          <Icon name="schedule" size={20} />
          {t.t('whatsapp.window.title')}
        </strong>
        <p className="text-body-sm text-text-2">{t.t('whatsapp.window.body')}</p>
        <div aria-hidden="true" className="flex flex-col gap-1">
          <div className="flex h-2.5 overflow-hidden rounded-full">
            <span className="flex-[2] bg-success" />
            <span className="flex-1 bg-border-strong opacity-50" />
          </div>
          <div className="flex justify-between font-mono text-caption font-normal text-text-muted">
            <span>{t.t('whatsapp.window.start')}</span>
            <span>{t.t('whatsapp.window.mark')}</span>
            <span>{t.t('whatsapp.window.end')}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col rounded-lg border border-border bg-surface p-4">
        <strong className="mb-2 flex items-center gap-2 text-label font-bold">
          <Icon name="payments" size={20} />
          {t.t('whatsapp.cost.title')}
        </strong>
        <dl data-testid="whatsapp-costs" className="m-0 flex flex-col">
          {costs.map(([label, level, tone]) => (
            <div
              key={label}
              className="flex justify-between gap-3 border-b border-border py-2.5 text-body-sm last:border-b-0"
            >
              <dt>{t.t(label)}</dt>
              <dd className={`m-0 font-bold ${tone}`}>{t.t(level)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-1.5 text-meta text-text-muted">{t.t('whatsapp.cost.note')}</p>
      </div>
    </>
  );
}
