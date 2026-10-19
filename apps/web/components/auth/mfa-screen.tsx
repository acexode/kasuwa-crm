'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from './button-classes';
import { OtpInput } from './otp-input';
import { ResendControl } from './resend-control';
import {
  reissueMfaChallenge,
  verifyMfa,
  type MfaChallengeStarted,
  type MfaMethodType,
  type ScreenError,
} from '../../lib/auth-api';
import type { LanguageOption } from './language-menu';

const CODE_LENGTH = 6;

export function MfaScreen({
  messages,
  locale,
  locales,
  challengeId,
  initialMethod,
  initialHint,
  initialResendAvailableAt,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
  challengeId: string;
  initialMethod: MfaMethodType;
  initialHint: string | null;
  initialResendAvailableAt: string | null;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();

  const [method, setMethod] = useState<MfaMethodType>(initialMethod);
  const [hint, setHint] = useState<string | null>(initialHint);
  const [resendAt, setResendAt] = useState<string | null>(initialResendAvailableAt);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error !== undefined) {
      alertRef.current?.focus();
    }
  }, [error]);

  const expired = error?.code === 'mfa_challenge_expired';
  const screenId = expired ? 'P01/2b' : method === 'sms' ? 'P01/2a' : 'P01/2';

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (pending) return;

      if (expired) {
        setPending(true);
        const reissued = await reissueMfaChallenge({ challengeId, method });
        setPending(false);
        if (reissued.ok) {
          applyChallenge(reissued.value);
          setError(undefined);
          setCode('');
        } else {
          setError(reissued.error);
        }
        return;
      }

      setError(undefined);
      setPending(true);
      const result = await verifyMfa({ challengeId, code });
      setPending(false);

      if (result.ok) {
        // The BFF has set the session cookie (the body carries no token,
        // ADR-0019 point 3). The front door, rendered on the server WITH that
        // cookie, sends the browser on to the app (app/page.tsx). `replace`,
        // so Back does not return to a spent challenge.
        router.replace('/');
        return;
      }
      setError(result.error);
    },
    [challengeId, code, expired, method, pending, router],
  );

  function applyChallenge(challenge: MfaChallengeStarted) {
    setMethod(challenge.method);
    setResendAt(challenge.resendAvailableAt);
    setHint(challenge.methods.find((entry) => entry.type === challenge.method)?.deliveryHint ?? null);
  }

  const switchTo = useCallback(
    async (next: MfaMethodType) => {
      setError(undefined);
      setPending(true);
      const result = await reissueMfaChallenge({ challengeId, method: next });
      setPending(false);
      if (result.ok) {
        applyChallenge(result.value);
        setCode('');
      } else {
        setError(result.error);
      }
    },
    [challengeId],
  );

  const attempts = error?.attemptsRemaining;

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
      <section data-screen={screenId} className="flex w-full max-w-lg flex-col gap-5">
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-full ${
            expired ? 'bg-danger-soft text-danger-text' : 'bg-primary-soft text-primary-text'
          }`}
        >
          <Icon name={expired ? 'timer_off' : method === 'sms' ? 'sms' : 'phone_iphone'} size="xl" />
        </span>

        <div className="flex flex-col gap-2">
          <h1 className="text-h3 text-text">
            {t.t(
              expired
                ? 'auth.mfa.title.expired'
                : method === 'sms'
                  ? 'auth.mfa.title.sms'
                  : 'auth.mfa.title.app',
            )}
          </h1>
          <p className="text-body-md text-text-2">
            {method === 'sms'
              ? t.t('auth.mfa.body.sms', { hint: hint ?? '' })
              : t.t('auth.mfa.body.app')}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
          <OtpInput
            value={code}
            onChange={setCode}
            groupLabel={t.t('auth.mfa.code.label')}
            digitLabel={(position) => t.t('auth.mfa.code.digit', { position })}
            invalid={error !== undefined}
            disabled={pending}
          />

          {error !== undefined ? (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              data-testid="mfa-error"
              data-error-code={error.code}
              className="flex gap-3 rounded-lg bg-danger-soft p-3 text-body-sm text-danger-text"
            >
              <Icon name={expired ? 'timer_off' : 'error'} />
              <span>
                <strong>{t.t(`auth.error.${error.code}` as MessageId)}</strong>
                {typeof attempts === 'number' ? (
                  <span> {t.t('auth.attemptsRemaining', { count: attempts })}</span>
                ) : null}
              </span>
            </div>
          ) : null}

          {method === 'sms' && !expired ? (
            <ResendControl
              resendAt={resendAt}
              waitingLabel={(clock) => t.t('auth.mfa.resend.in', { clock })}
              nowLabel={t.t('auth.mfa.resend.now')}
              onResend={() => void switchTo('sms')}
              disabled={pending}
            />
          ) : null}

          <button
            type="submit"
            disabled={pending || (!expired && code.length < CODE_LENGTH)}
            data-testid="mfa-submit"
            className={PRIMARY_BUTTON}
          >
            {t.t(expired ? 'auth.mfa.sendNew' : pending ? 'auth.mfa.verifying' : 'auth.mfa.verify')}
          </button>
        </form>

        {method === 'totp' && !expired ? (
          <label className="flex min-h-touch items-center gap-3 text-body-sm">
            <input type="checkbox" name="trustDevice" className="h-5 w-5 accent-primary" />
            {t.t('auth.mfa.trustDevice')}
          </label>
        ) : null}

        {method === 'sms' && !expired ? (
          <p className="text-caption text-text-muted">
            {t.t('auth.mfa.sms.slow')}{' '}
            <button type="button" className={QUIET_BUTTON}>
              {t.t('auth.mfa.sms.voice')}
            </button>
          </p>
        ) : null}

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <h2 className="text-h6 text-text-muted">{t.t('auth.mfa.alternatives')}</h2>
          {method === 'totp' ? (
            <>
              <button type="button" className={SECONDARY_BUTTON}>
                <Icon name="passkey" />
                {t.t('auth.mfa.alt.passkey')}
              </button>
              <button
                type="button"
                data-testid="switch-to-sms"
                onClick={() => void switchTo('sms')}
                className={SECONDARY_BUTTON}
              >
                <Icon name="sms" />
                {t.t('auth.mfa.alt.sms', { hint: hint ?? '' })}
              </button>
              <button type="button" onClick={() => void switchTo('backup_code')} className={SECONDARY_BUTTON}>
                <Icon name="key" />
                {t.t('auth.mfa.alt.backup')}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                data-testid="switch-to-app"
                onClick={() => void switchTo('totp')}
                className={SECONDARY_BUTTON}
              >
                <Icon name="phone_iphone" />
                {t.t('auth.mfa.alt.app')}
              </button>
              <button type="button" className={SECONDARY_BUTTON}>
                <Icon name="passkey" />
                {t.t('auth.mfa.alt.passkey')}
              </button>
            </>
          )}
        </div>
      </section>
    </AuthShell>
  );
}
