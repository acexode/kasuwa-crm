'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Button, Checkbox, TextField } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { useLiteMode } from './lite-mode';
import { SlowConnection } from './slow-connection';
import { signIn, type ScreenError } from '../../lib/auth-api';
import { maskEmail } from '../../lib/mask';
import { formatRetryTime } from '../../lib/retry-time';
import { browserSessionStore, rememberSmsOption, smsOptionHint, verifyPath } from '../../lib/mfa-sms-option';
import { availableFallbacks, rememberFallbacks } from '../../lib/mfa-fallbacks';
import { AUTH_COLUMN, AUTH_LINK, ICON_DISC, PAGE_SUBTITLE, PAGE_TITLE } from './auth-classes';
import { Emphasis, LeadSentence } from './rich-text';
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
        // The same rule for the passkey and backup-code rows (T-0131).
        rememberFallbacks(browserSessionStore(), result.value.challengeId, availableFallbacks(result.value.methods));
        router.push(verifyPath(result.value.challengeId));
        return;
      }
      setError(result.error);
    },
    [email, password, pending, router, tenantSlug],
  );

  // ---- P01/1b: the account is locked -------------------------------------
  if (error?.code === 'account_locked') {
    const retry = error.retryAt === undefined ? undefined : formatRetryTime(error.retryAt, error.timeZone, locale);
    return (
      <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
        <section data-screen="P01/1b" className={AUTH_COLUMN}>
          <span className={`${ICON_DISC} bg-danger-soft text-danger-text`}>
            <Icon name="lock_clock" size={28} />
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className={PAGE_TITLE}>{t.t('auth.locked.title')}</h1>
            <p className={PAGE_SUBTITLE}>
              <Emphasis
                sentence={(hint) => t.t('auth.locked.body', { emailHint: hint })}
                values={[<strong key="hint">{maskEmail(email)}</strong>]}
              />
            </p>
          </div>

          {/*
            The time AND its zone. "Try again in 15 minutes" is useless to
            someone whose phone clock is in another zone from the tenant, and
            BPO rosters routinely span WAT, EAT and SAST — so this is the normal
            case, not an edge one. The server sends an IANA zone precisely so
            this line can be unambiguous.
          */}
          {retry !== undefined ? (
            <p
              data-testid="lockout-retry"
              className="flex items-center gap-2.5 rounded-10 bg-surface-sunken px-3.5 py-3 text-body-sm"
            >
              <Icon name="schedule" size={20} className="text-text-2" />
              <span className="flex-1">
                <Emphasis
                  sentence={(time, zone) => t.t('auth.locked.retryAt', { time: time ?? '', zone: zone ?? '' })}
                  values={[
                    <strong key="time" className="font-mono">{retry.time}</strong>,
                    <strong key="zone" className="font-mono">{retry.zone}</strong>,
                  ]}
                />
              </span>
            </p>
          ) : null}

          <Button variant="primary" size="large" className="w-full">
            {t.t('auth.locked.resetEmail')}
          </Button>
          <Button size="large" className="w-full">
            {t.t('auth.locked.resetSms')}
          </Button>
          <p className="text-body-sm text-text-2">
            <Emphasis
              sentence={(link) => t.t('auth.locked.tellAdminSentence', { link: link ?? '' })}
              values={[
                <a key="admin" href="#tell-admin" className={AUTH_LINK}>
                  {t.t('auth.locked.tellAdmin')}
                </a>,
              ]}
            />
          </p>
        </section>
      </AuthShell>
    );
  }

  // ---- P01/1d: the network is slow ---------------------------------------
  if (pending && slow && !keepWaiting) {
    return (
      <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
        <SlowConnection
          title={t.t('auth.slow.title')}
          body={t.t('auth.slow.body')}
          switchLabel={t.t('auth.slow.switch')}
          keepWaitingLabel={t.t('auth.slow.keepWaiting')}
          skeletonLabel={t.t('auth.slow.loading')}
          // The lighter page IS the answer to "slow": switching shows the lite
          // form with the request still running, as the board's lite state.
          onSwitch={() => {
            setLite(true);
            setKeepWaiting(true);
          }}
          onKeepWaiting={() => setKeepWaiting(true)}
        />
      </AuthShell>
    );
  }

  const attempts = error?.attemptsRemaining;
  const credentialsWrong = error?.code === 'invalid_credentials';
  const google = t.t('auth.signIn.google');
  const microsoft = t.t('auth.signIn.microsoft');

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
      <section data-screen={error === undefined ? 'P01/1' : 'P01/1a'} className={AUTH_COLUMN}>
        <div className="flex flex-col gap-1.5">
          <h1 className={PAGE_TITLE}>{t.t('auth.signIn.title')}</h1>
          <p className="text-label font-normal text-text-2">{t.t('auth.signIn.subtitle')}</p>
        </div>

        {lite ? (
          <p
            role="status"
            className="flex items-start gap-2.5 rounded-10 bg-accent-soft px-3.5 py-3 text-body-sm text-accent-text"
          >
            <Icon name="network_check" size={20} />
            <span>
              <LeadSentence text={t.t('auth.lite.on')} locale={locale} />
            </span>
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
            className="flex gap-2.5 rounded-10 bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text outline-offset-2"
          >
            <Icon name="error" size={20} />
            <span>
              <LeadSentence text={t.t(errorMessageId(error))} locale={locale} />
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
            <Button size="large" icon="passkey" className="w-full">
              {t.t('auth.signIn.passkey')}
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button size="large" className="w-full">
                <ProviderMark letter={google} />
                {google}
              </Button>
              <Button size="large" className="w-full">
                <ProviderMark letter={microsoft} />
                {microsoft}
              </Button>
            </div>
            <a
              href="/sso"
              className="flex h-control-lg items-center justify-center gap-2 rounded-md text-label text-primary-text hover:bg-primary-soft focus-visible:ring-focus"
            >
              <Icon name="domain" size={20} />
              {t.t('auth.signIn.sso')}
            </a>
            <p className="flex items-center gap-3 text-meta text-text-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
              {t.t('auth.signIn.divider')}
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </p>
          </>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4.5" noValidate>
          <TextField
            id={`${formId}-slug`}
            size="large"
            label={t.t('auth.signIn.workspace.label')}
            hint={t.t('auth.signIn.workspace.help')}
            name="tenantSlug"
            autoComplete="organization"
            required
            value={tenantSlug}
            onChange={(event) => setTenantSlug(event.target.value)}
          />

          <TextField
            id={`${formId}-email`}
            size="large"
            label={t.t('auth.signIn.email.label')}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            required
            placeholder={t.t('auth.signIn.email.placeholder')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            // `invalid` on BOTH fields or neither. Marking only one would
            // re-introduce, on screen and in the accessibility tree, exactly
            // the distinction the message refuses to make.
            invalid={credentialsWrong}
          />

          {/*
            "Forgot password?" sits BESIDE the label (`labelAside`), not inside
            it. A link nested in a <label> becomes part of the field's
            accessible name, so the password box would announce itself as
            "Password Forgot password?" — and a screen-reader user would hear a
            question where a field name belongs. It also stops
            `getByLabel('Password')` matching, which is how this was found.
          */}
          <TextField
            id={`${formId}-password`}
            size="large"
            mono
            label={t.t('auth.signIn.password.label')}
            labelAside={
              <a href="#forgot" className={AUTH_LINK}>
                {t.t('auth.signIn.password.forgot')}
              </a>
            }
            name="password"
            type={revealed ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={credentialsWrong}
            trailing={
              <button
                type="button"
                onClick={() => setRevealed((previous) => !previous)}
                aria-pressed={revealed}
                aria-label={t.t(revealed ? 'auth.signIn.password.hide' : 'auth.signIn.password.show')}
                className="flex size-control-base items-center justify-center rounded-6 text-text-2 hover:bg-surface-sunken focus-visible:ring-focus"
              >
                <Icon name={revealed ? 'visibility_off' : 'visibility'} size={20} />
              </button>
            }
          />

          <Checkbox name="remember" defaultChecked label={t.t('auth.signIn.remember')} />

          <Button
            type="submit"
            variant="primary"
            size="large"
            loading={pending}
            loadingLabel={t.t('auth.signIn.submitting')}
            className="w-full"
          >
            {t.t('auth.signIn.submit')}
          </Button>
        </form>

        {lite ? <p className="text-meta text-text-muted">{t.t('auth.lite.deferred')}</p> : null}

        {signUpOpen ? (
          <p className="text-center text-body-sm text-text-2">
            {t.t('auth.signIn.newHere')}{' '}
            <a href="/sign-up" className={AUTH_LINK}>
              {t.t('auth.signIn.createAccount')}
            </a>
          </p>
        ) : null}
      </section>
    </AuthShell>
  );
}

/**
 * The boxed initial on the Google and Microsoft buttons. The letter is the
 * first letter of the (passthrough) provider name, so nothing is typed here.
 */
function ProviderMark({ letter }: { letter: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 items-center justify-center rounded-sm border-2 border-current text-overline font-extrabold"
    >
      {letter.charAt(0)}
    </span>
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
