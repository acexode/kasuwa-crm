'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { useLiteMode } from './lite-mode';
import { SlowConnection } from './slow-connection';
import { signIn, type ScreenError } from '../../lib/auth-api';
import { maskEmail } from '../../lib/mask';
import { formatRetryTime } from '../../lib/retry-time';
import { browserSessionStore, rememberSmsOption, smsOptionHint, verifyPath } from '../../lib/mfa-sms-option';
import { FIELD, LINK, PRIMARY_BUTTON, SECONDARY_BUTTON } from './button-classes';
import type { LanguageOption } from './language-menu';

/**
 * `P01/1` — sign in — and the three failure states that live on the same route.
 *
 *   P01/1   the form
 *   P01/1a  wrong credentials
 *   P01/1b  the account is locked
 *   P01/1d  the network is slow
 *
 * ---------------------------------------------------------------------------
 * THE THING MOST LIKELY TO BE "IMPROVED" BY ACCIDENT
 *
 * `P01/1a` does not say which field was wrong, and it must not start to. An
 * error that distinguishes "no such email" from "wrong password" is a
 * user-enumeration oracle: an attacker with a list of addresses learns who
 * banks where by reading the difference. It is the same rule as the API's
 * "not authenticated" (`CLAUDE.md` section 6.4), asserted here as well because
 * the UI is where it gets softened for usability by someone who has not read
 * that section.
 *
 * The lockout counter has to behave identically too, or the counter becomes the
 * oracle the message is not. The server keys it on the submitted identifier
 * whether or not an account exists, and this screen renders whatever
 * `attemptsRemaining` it is given without ever checking the address itself.
 * ---------------------------------------------------------------------------
 */

/**
 * How long a pending request may stay a skeleton before the screen says
 * something. Four seconds is the design's number. It is deliberately not a
 * spinner: a spinner at 256 kbps tells a person nothing they did not already
 * know, whereas "your network is slow, here is a lighter page" is an action.
 */
const STILL_CONNECTING_MS = 4_000;

export function SignInScreen({
  messages,
  locale,
  locales,
  signUpOpen,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
  /** `self_serve_signup`, evaluated on the server. Off hides the link as well as the route. */
  signUpOpen: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();
  const { lite, setLite } = useLiteMode();

  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [keepWaiting, setKeepWaiting] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);

  const alertRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  // The "still connecting" timer. It runs on the REQUEST, not on a render, so
  // it cannot fire on a fast connection and cannot be forgotten on a slow one.
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // Focus the message when one appears, so a screen-reader user hears it and a
  // keyboard user is standing next to the field they have to fix.
  useEffect(() => {
    if (error !== undefined) {
      alertRef.current?.focus();
    }
  }, [error]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (pending) return;

      setError(undefined);
      setKeepWaiting(false);
      setPending(true);

      const result = await signIn({ tenantSlug, email, password });
      setPending(false);

      if (result.ok) {
        // Whether P01/2 may offer SMS, and the masked number it would offer,
        // travel in sessionStorage keyed by the challenge — never in the URL
        // (T-0126, `lib/mfa-sms-option.ts`).
        rememberSmsOption(
          browserSessionStore(),
          result.value.challengeId,
          smsOptionHint(result.value.methods),
        );
        router.push(verifyPath(result.value.challengeId));
        return;
      }
      setError(result.error);
    },
    [email, password, pending, router, tenantSlug],
  );

  // ---- P01/1b: the account is locked -------------------------------------
  if (error?.code === 'account_locked') {
    return (
      <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
        <section data-screen="P01/1b" className="flex w-full max-w-lg flex-col gap-5">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-danger-soft text-danger-text">
            <Icon name="lock_clock" size="xl" />
          </span>
          <h1 className="text-h3 text-text">{t.t('auth.locked.title')}</h1>
          <p className="text-body-md text-text-2">
            {t.t('auth.locked.body', { emailHint: maskEmail(email) })}
          </p>

          {/*
            The time AND its zone. "Try again in 15 minutes" is useless to
            someone whose phone clock is in another zone from the tenant, and
            BPO rosters routinely span WAT, EAT and SAST — so this is the normal
            case, not an edge one. The server sends an IANA zone precisely so
            this line can be unambiguous.
          */}
          {error.retryAt !== undefined ? (
            <p
              data-testid="lockout-retry"
              className="flex items-center gap-3 rounded-lg bg-surface-sunken p-3 text-body-sm"
            >
              <Icon name="schedule" className="text-text-2" />
              <span>{t.t('auth.locked.retryAt', formatRetryTime(error.retryAt, error.timeZone, locale))}</span>
            </p>
          ) : null}

          <button type="button" className={PRIMARY_BUTTON}>
            {t.t('auth.locked.resetEmail')}
          </button>
          <button type="button" className={SECONDARY_BUTTON}>
            {t.t('auth.locked.resetSms')}
          </button>
          <p className="text-body-sm text-text-2">{t.t('auth.locked.notYou')}</p>
          <a href="#tell-admin" className={LINK}>
            {t.t('auth.locked.tellAdmin')}
          </a>
        </section>
      </AuthShell>
    );
  }

  // ---- P01/1d: the network is slow ---------------------------------------
  if (pending && slow && !keepWaiting) {
    return (
      <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
        <SlowConnection
          title={t.t('auth.slow.title')}
          body={t.t('auth.slow.body')}
          switchLabel={t.t('auth.slow.switch')}
          keepWaitingLabel={t.t('auth.slow.keepWaiting')}
          skeletonLabel={t.t('auth.slow.loading')}
          onSwitch={() => setLite(true)}
          onKeepWaiting={() => setKeepWaiting(true)}
        />
      </AuthShell>
    );
  }

  const attempts = error?.attemptsRemaining;

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
      <section data-screen={error === undefined ? 'P01/1' : 'P01/1a'} className="flex w-full max-w-lg flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-h3 text-text">{t.t('auth.signIn.title')}</h1>
          <p className="text-body-sm text-text-2">{t.t('auth.signIn.subtitle')}</p>
        </div>

        {lite ? (
          <p className="flex items-start gap-3 rounded-lg bg-accent-soft p-3 text-body-sm text-accent-text">
            <Icon name="network_check" />
            <span>{t.t('auth.lite.on')}</span>
          </p>
        ) : null}

        {/*
          ONE message for every first-factor failure. It says what happened and
          what to do, and it never says which field was wrong — see the note at
          the top of this file before changing a word of it.
        */}
        {error !== undefined ? (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            data-testid="sign-in-error"
            data-error-code={error.code}
            className="flex gap-3 rounded-lg bg-danger-soft p-3 text-body-sm text-danger-text outline-offset-2"
          >
            <Icon name="error" />
            <span>
              <strong>{t.t(errorMessageId(error))}</strong>
              {typeof attempts === 'number' ? (
                <span data-testid="attempts-remaining">
                  {' '}
                  {t.t('auth.attemptsRemaining', { count: attempts })}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {/*
          Federated sign-in is not rendered in lite mode: four extra controls
          that each start a third-party navigation are the first thing to drop
          when the page has to arrive at all. The design says so, and the lite
          page tells the user where they went.
        */}
        {lite ? null : (
          <>
            <button type="button" className={SECONDARY_BUTTON}>
              <Icon name="passkey" size="lg" />
              {t.t('auth.signIn.passkey')}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={SECONDARY_BUTTON}>
                {t.t('auth.signIn.google')}
              </button>
              <button type="button" className={SECONDARY_BUTTON}>
                {t.t('auth.signIn.microsoft')}
              </button>
            </div>
            <a href="/sso" className={`${SECONDARY_BUTTON} border-transparent text-primary-text`}>
              <Icon name="domain" />
              {t.t('auth.signIn.sso')}
            </a>
            <p className="flex items-center gap-3 text-caption text-text-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              {t.t('auth.signIn.divider')}
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </p>
          </>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2" htmlFor={`${formId}-slug`}>
            <span className="text-body-sm font-semibold">{t.t('auth.signIn.workspace.label')}</span>
            <input
              id={`${formId}-slug`}
              name="tenantSlug"
              autoComplete="organization"
              required
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value)}
              aria-describedby={`${formId}-slug-help`}
              className={FIELD}
            />
            <span id={`${formId}-slug-help`} className="text-caption text-text-muted">
              {t.t('auth.signIn.workspace.help')}
            </span>
          </label>

          <label className="flex flex-col gap-2" htmlFor={`${formId}-email`}>
            <span className="text-body-sm font-semibold">{t.t('auth.signIn.email.label')}</span>
            <input
              id={`${formId}-email`}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              required
              placeholder={t.t('auth.signIn.email.placeholder')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              // `aria-invalid` on BOTH fields or neither. Marking only one
              // would re-introduce, in the accessibility tree, exactly the
              // distinction the message refuses to make.
              aria-invalid={error?.code === 'invalid_credentials'}
              className={FIELD}
            />
          </label>

          {/*
            "Forgot password?" is a SIBLING of the label, not inside it. A link
            nested in a <label> becomes part of the field's accessible name, so
            the password box would announce itself as "Password Forgot
            password?" — and a screen-reader user would hear a question where a
            field name belongs. It also stops `getByLabel('Password')` matching,
            which is how this was found.
          */}
          <div className="flex flex-col gap-2">
            <span className="flex items-baseline justify-between gap-3 text-body-sm font-semibold">
              <label htmlFor={`${formId}-password`}>{t.t('auth.signIn.password.label')}</label>
              <a href="#forgot" className={LINK}>
                {t.t('auth.signIn.password.forgot')}
              </a>
            </span>
            <span className="flex items-center gap-1">
              <input
                id={`${formId}-password`}
                name="password"
                type={revealed ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error?.code === 'invalid_credentials'}
                className={`${FIELD} flex-1 font-mono`}
              />
              <button
                type="button"
                onClick={() => setRevealed((previous) => !previous)}
                aria-pressed={revealed}
                aria-label={t.t(revealed ? 'auth.signIn.password.hide' : 'auth.signIn.password.show')}
                className="flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-2 hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Icon name={revealed ? 'visibility_off' : 'visibility'} />
              </button>
            </span>
          </div>

          <label className="flex min-h-touch items-center gap-3 text-body-sm">
            <input type="checkbox" name="remember" defaultChecked className="h-5 w-5 accent-primary" />
            {t.t('auth.signIn.remember')}
          </label>

          <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
            {t.t(pending ? 'auth.signIn.submitting' : 'auth.signIn.submit')}
          </button>
        </form>

        {lite ? <p className="text-caption text-text-muted">{t.t('auth.lite.deferred')}</p> : null}

        {signUpOpen ? (
          <p className="text-center text-body-sm text-text-2">
            {t.t('auth.signIn.newHere')}{' '}
            <a href="/sign-up" className={LINK}>
              {t.t('auth.signIn.createAccount')}
            </a>
          </p>
        ) : null}
      </section>
    </AuthShell>
  );
}

/**
 * `auth.error.<code>` — the convention from `docs/api/README.md`. Switching on
 * `code` and never on `message` is what lets the server reword its English
 * prose without silently changing what a Hausa speaker reads.
 */
function errorMessageId(error: ScreenError): MessageId {
  return `auth.error.${error.code}` as MessageId;
}
