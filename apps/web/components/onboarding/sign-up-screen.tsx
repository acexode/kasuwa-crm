'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Button, Chip, Select, TextField } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { AuthShell } from '../auth/auth-shell';
import { shellStrings } from '../auth/shell-strings';
import { AUTH_LINK, PAGE_SUBTITLE, PAGE_TITLE } from '../auth/auth-classes';
import type { LanguageOption } from '../auth/language-menu';
import type { ScreenError } from '../../lib/auth-api';
import { EMPLOYEE_SIZES, signUp, type EmployeeSize } from '../../lib/sign-up-api';
import {
  DEFAULT_SIGN_UP_COUNTRY,
  SIGN_UP_COUNTRIES,
  dialCode,
  toE164,
  type SignUpCountry,
} from '../../lib/phone';
import { formatRetryTime } from '../../lib/retry-time';
import { numberingLocale } from '../../lib/numbering';

/**
 * `P01/3` — create a workspace. Behind `self_serve_signup` (D-P2); the page
 * that renders this returns 404 while the flag is off.
 *
 * ---------------------------------------------------------------------------
 * D-P3: THERE IS NO "ALREADY REGISTERED" STATE, AND THERE MUST NOT BE ONE.
 *
 * The contract answers 202 with one body whether or not the address already
 * has an account, and tells the existing account by email instead. An inline
 * "that email is taken" on a public form is a user-enumeration oracle — the
 * same defect `P01/1a` was drawn to avoid two screens earlier. So a successful
 * submission always goes to `P01/4`, carrying only what the SERVER sent back
 * (the masked hints and the verification id), never the address typed here.
 * A new address and an existing one therefore render the same page.
 * ---------------------------------------------------------------------------
 *
 * Two deviations from the board, both forced by the contract and named in
 * team/reports/T-0007b.md: a Password field (`SignUpRequest.password`, minimum
 * 12), and no carrier badge beside the number — detecting the network needs a
 * prefix table that number portability makes wrong, and the contract has no
 * field for it.
 */

type Field = 'fullName' | 'email' | 'phone' | 'company' | 'password';

const REQUIRED_PASSWORD_LENGTH = 12;

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function SignUpScreen({
  messages,
  locale,
  locales,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();
  const id = useId();
  const alertRef = useRef<HTMLDivElement>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [dial, setDial] = useState<SignUpCountry>(DEFAULT_SIGN_UP_COUNTRY);
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [country, setCountry] = useState<SignUpCountry>(DEFAULT_SIGN_UP_COUNTRY);
  const [password, setPassword] = useState('');
  const [size, setSize] = useState<EmployeeSize>('51-200');
  const [isBpo, setIsBpo] = useState(true);

  const [invalid, setInvalid] = useState<readonly Field[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);

  useEffect(() => {
    if (error !== undefined || invalid.length > 0) {
      alertRef.current?.focus();
    }
  }, [error, invalid]);

  const sizeFormat = new Intl.NumberFormat(numberingLocale(locale));
  const sizeLabel = (value: EmployeeSize): string => {
    if (value.endsWith('+')) return `${sizeFormat.format(Number(value.slice(0, -1)))}+`;
    const [low, high] = value.split('-').map(Number);
    return `${sizeFormat.format(low ?? 0)}–${sizeFormat.format(high ?? 0)}`;
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;

    const phoneE164 = toE164(dial, phone);
    const problems: Field[] = [];
    if (fullName.trim() === '') problems.push('fullName');
    if (!looksLikeEmail(email.trim())) problems.push('email');
    if (phoneE164 === null) problems.push('phone');
    if (company.trim() === '') problems.push('company');
    if (password.length < REQUIRED_PASSWORD_LENGTH) problems.push('password');

    setInvalid(problems);
    setError(undefined);
    if (problems.length > 0 || phoneE164 === null) return;

    setPending(true);
    const result = await signUp({
      fullName: fullName.trim(),
      email: email.trim(),
      phoneE164,
      organisationName: company.trim(),
      country,
      employeeSize: size,
      isBpo,
      password,
      acceptedTermsAt: new Date().toISOString(),
    });
    setPending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    // Only what the server sent. See the D-P3 note above.
    const query = new URLSearchParams({
      verification: result.value.verificationId,
      resendAt: result.value.resendAvailableAt,
    });
    if (typeof result.value.emailHint === 'string') query.set('email', result.value.emailHint);
    if (typeof result.value.phoneHint === 'string') query.set('phone', result.value.phoneHint);
    router.push(`/sign-up/verify?${query.toString()}`);
  }

  const isInvalid = (field: Field) => invalid.includes(field);
  const describedBy = (field: Field, help?: string) =>
    [help, isInvalid(field) ? `${id}-${field}-error` : undefined].filter(Boolean).join(' ') || undefined;
  const fieldError = (field: Field) =>
    isInvalid(field) ? t.t(`signup.invalid.${field}` as MessageId) : undefined;

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
      <section data-screen="P01/3" className="flex w-full max-w-layout-column-wide flex-col gap-4.5">
        <div className="flex flex-col gap-1.5">
          <h1 className={PAGE_TITLE}>{t.t('signup.title')}</h1>
          <p className={PAGE_SUBTITLE}>{t.t('signup.subtitle')}</p>
        </div>

        {error !== undefined || invalid.length > 0 ? (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            data-testid="sign-up-error"
            data-error-code={error?.code ?? 'validation_failed'}
            className="flex gap-2.5 rounded-10 bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text outline-offset-2"
          >
            <Icon name="error" size={20} />
            <span className="flex flex-col gap-1">
              <strong>{t.t(`auth.error.${error?.code ?? 'validation_failed'}` as MessageId)}</strong>
              {error?.retryAt !== undefined ? (
                <span>{t.t('auth.locked.retryAt', formatRetryTime(error.retryAt, error.timeZone, locale))}</span>
              ) : null}
            </span>
          </div>
        ) : null}

        <form onSubmit={submit} className="flex flex-col gap-4.5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id={`${id}-fullName`}
              size="large"
              label={t.t('signup.fullName.label')}
              name="fullName"
              autoComplete="name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              error={fieldError('fullName')}
            />
            <TextField
              id={`${id}-email`}
              size="large"
              label={t.t('signup.email.label')}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              hint={t.t('signup.email.help')}
              error={fieldError('email')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-phone`} className="text-body-sm font-semibold">
              {t.t('signup.phone.label')}
            </label>
            {/*
              The export's joined phone control: the country code as a sunken
              segment, then the national number in mono. The segment is the
              platform <select> laid invisibly over its own drawing, so the
              list is the phone's native picker and the closed control shows
              only the flag and the code. No carrier badge: detecting the
              network needs a prefix table that number portability makes wrong
              (team/reports/T-0007b.md).
            */}
            <span
              className={`flex h-control-lg items-stretch overflow-hidden rounded-md bg-surface focus-within:field-focus ${
                isInvalid('phone') ? 'border-2 border-danger' : 'border border-border-strong'
              }`}
            >
              <span className="relative flex items-center gap-1.5 border-e border-border bg-surface-sunken pe-2 ps-3">
                <span aria-hidden="true" className="text-body-md">
                  {flagOf(dial)}
                </span>
                <span aria-hidden="true" dir="ltr" className="font-mono text-body-sm">
                  {`+${dialCode(dial)}`}
                </span>
                <Icon name="expand_more" size={18} className="text-text-muted" />
                <select
                  aria-label={t.t('signup.phone.country')}
                  value={dial}
                  onChange={(event) => setDial(event.target.value as SignUpCountry)}
                  className="absolute inset-0 cursor-pointer appearance-none opacity-0"
                >
                  {SIGN_UP_COUNTRIES.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {`+${entry.dial} · ${t.t(`signup.country.${entry.code}` as MessageId)}`}
                    </option>
                  ))}
                </select>
              </span>
              <input
                id={`${id}-phone`}
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                aria-invalid={isInvalid('phone')}
                aria-describedby={describedBy('phone', `${id}-phone-help`)}
                className="min-w-0 flex-1 border-0 bg-transparent px-2.5 font-mono text-body-md text-text outline-none placeholder:text-text-muted"
              />
            </span>
            {isInvalid('phone') ? (
              <span id={`${id}-phone-error`} className="text-meta text-danger-text">
                {fieldError('phone')}
              </span>
            ) : null}
            <span id={`${id}-phone-help`} className="text-meta text-text-muted">
              {t.t('signup.phone.help', { dial: `+${dialCode(dial)}` })}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id={`${id}-company`}
              size="large"
              label={t.t('signup.company.label')}
              name="organisationName"
              autoComplete="organization"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              error={fieldError('company')}
            />
            <Select
              size="large"
              label={t.t('signup.country.label')}
              name="country"
              value={country}
              onChange={(event) => setCountry(event.target.value as SignUpCountry)}
            >
              {SIGN_UP_COUNTRIES.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {t.t(`signup.country.${entry.code}` as MessageId)}
                </option>
              ))}
            </Select>
          </div>

          {/* Not on the board: the contract needs a password (D-L195). */}
          <TextField
            id={`${id}-password`}
            size="large"
            label={t.t('signup.password.label')}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={t.t('signup.password.help')}
            error={fieldError('password')}
          />

          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-body-sm font-semibold">{t.t('signup.employees.legend')}</legend>
            <div className="flex flex-wrap gap-2">
              {EMPLOYEE_SIZES.map((value) => (
                <Chip
                  key={value}
                  variant="choice"
                  large
                  active={size === value}
                  aria-pressed={size === value}
                  onClick={() => setSize(value)}
                >
                  {sizeLabel(value)}
                </Chip>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            role="switch"
            aria-checked={isBpo}
            onClick={() => setIsBpo(!isBpo)}
            className={`flex items-center gap-3.5 rounded-10 border p-3.5 text-start text-text focus-visible:ring-focus ${
              isBpo ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface'
            }`}
          >
            <span className="flex flex-1 flex-col gap-0.5">
              <strong className="text-label font-bold">{t.t('signup.bpo.title')}</strong>
              <span className="text-meta text-text-2">{t.t(isBpo ? 'signup.bpo.on' : 'signup.bpo.off')}</span>
            </span>
            {/* The v1.1 switch track and knob, drawn inside the card that is the switch. */}
            <span
              aria-hidden="true"
              className={`relative inline-flex h-6.5 w-touch flex-shrink-0 rounded-full transition-colors duration-quick ${
                isBpo ? 'bg-primary' : 'bg-border-strong'
              }`}
            >
              <span
                className={`absolute start-0.75 top-0.75 size-5 rounded-full bg-on-primary shadow-knob transition-transform duration-quick ${
                  isBpo ? 'translate-x-4.5 rtl:-translate-x-4.5' : ''
                }`}
              />
            </span>
          </button>

          <Button
            type="submit"
            variant="primary"
            size="large"
            loading={pending}
            loadingLabel={t.t('signup.submitting')}
            data-testid="sign-up-submit"
            className="w-full"
          >
            {t.t('signup.submit')}
          </Button>
        </form>

        <p className="text-meta text-text-muted">
          {t.t('signup.terms')} {t.t('signup.signIn.prompt')}{' '}
          <a href="/" className={AUTH_LINK}>
            {t.t('signup.signIn.link')}
          </a>
        </p>
      </section>
    </AuthShell>
  );
}

/**
 * The country's flag as its regional-indicator emoji: two code points the
 * phone's own emoji font draws, so no image is sent (256 kbps) and no colour
 * is typed here.
 */
function flagOf(country: SignUpCountry): string {
  return String.fromCodePoint(...[...country].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}
