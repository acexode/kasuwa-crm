'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { AuthShell } from '../auth/auth-shell';
import { shellStrings } from '../auth/shell-strings';
import { FIELD, LINK, PRIMARY_BUTTON } from '../auth/button-classes';
import type { LanguageOption } from '../auth/language-menu';
import { EMPLOYEE_SIZES, signUp, type EmployeeSize, type ScreenError } from '../../lib/auth-api';
import {
  DEFAULT_SIGN_UP_COUNTRY,
  SIGN_UP_COUNTRIES,
  dialCode,
  toE164,
  type SignUpCountry,
} from '../../lib/phone';
import { formatRetryTime } from '../../lib/retry-time';

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

  const sizeFormat = new Intl.NumberFormat(locale);
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
      <section data-screen="P01/3" className="flex w-full max-w-xl flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h1 className="text-h3 text-text">{t.t('signup.title')}</h1>
          <p className="text-body-md text-text-2">{t.t('signup.subtitle')}</p>
        </div>

        {error !== undefined || invalid.length > 0 ? (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            data-testid="sign-up-error"
            data-error-code={error?.code ?? 'validation_failed'}
            className="flex flex-col gap-1 rounded-lg bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            <strong>{t.t(`auth.error.${error?.code ?? 'validation_failed'}` as MessageId)}</strong>
            {error?.retryAt !== undefined ? (
              <span>{t.t('auth.locked.retryAt', formatRetryTime(error.retryAt, error.timeZone, locale))}</span>
            ) : null}
          </div>
        ) : null}

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              id={`${id}-fullName`}
              label={t.t('signup.fullName.label')}
              name="fullName"
              autoComplete="name"
              value={fullName}
              onChange={setFullName}
              invalid={isInvalid('fullName')}
              error={fieldError('fullName')}
            />
            <TextField
              id={`${id}-email`}
              label={t.t('signup.email.label')}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
              invalid={isInvalid('email')}
              help={t.t('signup.email.help')}
              error={fieldError('email')}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-phone`} className="text-body-sm font-semibold">
              {t.t('signup.phone.label')}
            </label>
            <div className="flex gap-2">
              <select
                aria-label={t.t('signup.phone.country')}
                value={dial}
                onChange={(event) => setDial(event.target.value as SignUpCountry)}
                className={`${FIELD} font-mono`}
              >
                {SIGN_UP_COUNTRIES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {`+${entry.dial} · ${t.t(`signup.country.${entry.code}` as MessageId)}`}
                  </option>
                ))}
              </select>
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
                className={`${FIELD} min-w-0 flex-1 font-mono`}
              />
            </div>
            <span id={`${id}-phone-help`} className="text-caption text-text-muted">
              {t.t('signup.phone.help', { dial: `+${dialCode(dial)}` })}
            </span>
            {isInvalid('phone') ? (
              <span id={`${id}-phone-error`} className="text-body-sm text-danger-text">
                {fieldError('phone')}
              </span>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              id={`${id}-company`}
              label={t.t('signup.company.label')}
              name="organisationName"
              autoComplete="organization"
              value={company}
              onChange={setCompany}
              invalid={isInvalid('company')}
              error={fieldError('company')}
            />
            <label className="flex flex-col gap-2">
              <span className="text-body-sm font-semibold">{t.t('signup.country.label')}</span>
              <select
                name="country"
                value={country}
                onChange={(event) => setCountry(event.target.value as SignUpCountry)}
                className={FIELD}
              >
                {SIGN_UP_COUNTRIES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {t.t(`signup.country.${entry.code}` as MessageId)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <TextField
            id={`${id}-password`}
            label={t.t('signup.password.label')}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            invalid={isInvalid('password')}
            help={t.t('signup.password.help')}
            error={fieldError('password')}
          />

          <fieldset className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-body-sm font-semibold">{t.t('signup.employees.legend')}</legend>
            <div className="flex flex-wrap gap-2">
              {EMPLOYEE_SIZES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={size === value}
                  onClick={() => setSize(value)}
                  className={`min-h-touch rounded-md border px-3 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    size === value
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-border-strong bg-surface text-text'
                  }`}
                >
                  {sizeLabel(value)}
                </button>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            role="switch"
            aria-checked={isBpo}
            onClick={() => setIsBpo(!isBpo)}
            className={`flex min-h-touch items-center gap-3 rounded-lg border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              isBpo ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface'
            }`}
          >
            <span className="flex flex-1 flex-col gap-1">
              <strong className="text-body-md text-text">{t.t('signup.bpo.title')}</strong>
              <span className="text-body-sm text-text-2">{t.t(isBpo ? 'signup.bpo.on' : 'signup.bpo.off')}</span>
            </span>
            <span
              aria-hidden="true"
              className={`flex h-6 w-10 flex-shrink-0 items-center rounded-full p-1 ${
                isBpo ? 'justify-end bg-primary' : 'justify-start bg-border-strong'
              }`}
            >
              <span className="h-4 w-4 rounded-full bg-surface" />
            </span>
          </button>

          <button type="submit" disabled={pending} data-testid="sign-up-submit" className={PRIMARY_BUTTON}>
            {t.t(pending ? 'signup.submitting' : 'signup.submit')}
          </button>
        </form>

        <p className="text-caption text-text-muted">{t.t('signup.terms')}</p>
        <p className="text-body-sm text-text-2">
          {t.t('signup.signIn.prompt')}{' '}
          <a href="/" className={LINK}>
            {t.t('signup.signIn.link')}
          </a>
        </p>
      </section>
    </AuthShell>
  );
}

/**
 * A labelled text input whose accessible name is the LABEL ALONE. Help and
 * error text are attached with `aria-describedby`, not wrapped inside the
 * label — wrapping them makes a screen reader read the help text twice, once as
 * the name and once as the description, and it was how the first draft of this
 * form named its password field "Password At least 12 characters…".
 */
function TextField({
  id,
  label,
  name,
  value,
  onChange,
  invalid,
  type = 'text',
  inputMode,
  autoComplete,
  help,
  error,
}: {
  id: string;
  label: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
  type?: 'text' | 'email' | 'password';
  inputMode?: 'text' | 'email';
  autoComplete: string;
  help?: string;
  error?: string | undefined;
}) {
  const described = [help === undefined ? undefined : `${id}-help`, error === undefined ? undefined : `${id}-error`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-body-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={described === '' ? undefined : described}
        className={FIELD}
      />
      {help === undefined ? null : (
        <span id={`${id}-help`} className="text-caption text-text-muted">
          {help}
        </span>
      )}
      {error === undefined ? null : (
        <span id={`${id}-error`} className="text-body-sm text-danger-text">
          {error}
        </span>
      )}
    </div>
  );
}
