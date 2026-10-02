'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AuthShell } from '../auth/auth-shell';
import { shellStrings } from '../auth/shell-strings';
import { LINK, PRIMARY_BUTTON } from '../auth/button-classes';
import { OtpInput } from '../auth/otp-input';
import { ResendControl } from '../auth/resend-control';
import type { LanguageOption } from '../auth/language-menu';
import { resendOtp, verifyOtp, type ScreenError } from '../../lib/auth-api';
import { formatRetryTime } from '../../lib/retry-time';

/**
 * `P01/4` — check your email and phone. Behind `self_serve_signup`.
 *
 * This is also D-P3's neutral state. Whether or not the address already had an
 * account, sign-up answered 202 and lands here; the page shows only the masked
 * hints the server returned, so the two cases are the same page.
 *
 * The email is confirmed by a LINK, the phone by a six-digit code. Which of the
 * two is done is learned from `verifyOtp`'s answer, never assumed: until the
 * server says the email is verified, the card says it is waiting.
 *
 * The resend countdown runs to the server's `resendAvailableAt`, not from a
 * local sixty — the same rule as `P01/2a`. `resendOtp` publishes no 202 example
 * in the contract, so on the mock it answers 501 and the screen says so; that
 * gap is reported rather than papered over with an invented body.
 */

const CODE_LENGTH = 6;

export function VerifyScreen({
  messages,
  locale,
  locales,
  verificationId,
  emailHint,
  phoneHint,
  initialResendAt,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
  verificationId: string;
  emailHint: string | null;
  phoneHint: string | null;
  initialResendAt: string | null;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();
  const alertRef = useRef<HTMLDivElement>(null);

  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);
  const [emailVerified, setEmailVerified] = useState(false);
  const [waitingForEmail, setWaitingForEmail] = useState(false);
  const [resendAt, setResendAt] = useState<string | null>(initialResendAt);

  useEffect(() => {
    if (error !== undefined || waitingForEmail) {
      alertRef.current?.focus();
    }
  }, [error, waitingForEmail]);

  if (verificationId === '') {
    return (
      <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
        <section data-screen="P01/4" className="flex w-full max-w-lg flex-col gap-4">
          <h1 className="text-h3 text-text">{t.t('verify.title')}</h1>
          <p role="alert" className="text-body-md text-text-2">
            {t.t('verify.missing')}
          </p>
          <a href="/sign-up" className={PRIMARY_BUTTON}>
            {t.t('verify.restart')}
          </a>
        </section>
      </AuthShell>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || code.length < CODE_LENGTH) return;

    setError(undefined);
    setWaitingForEmail(false);
    setPending(true);
    const result = await verifyOtp({ verificationId, channel: 'phone', code });
    setPending(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEmailVerified(result.value.emailVerified);
    if (result.value.nextStep === 'onboarding') {
      router.push('/sign-up/region');
      return;
    }
    if (result.value.nextStep === 'verify_email') {
      setWaitingForEmail(true);
    }
  }

  async function resend() {
    setError(undefined);
    setPending(true);
    const result = await resendOtp({ verificationId, channel: 'phone' });
    setPending(false);
    if (result.ok) {
      setResendAt(result.value.resendAvailableAt);
      setCode('');
      return;
    }
    setError(result.error);
  }

  const attempts = error?.attemptsRemaining;

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
      <section data-screen="P01/4" className="flex w-full max-w-lg flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h1 className="text-h3 text-text">{t.t('verify.title')}</h1>
          <p className="text-body-md text-text-2">{t.t('verify.subtitle')}</p>
        </div>

        <div
          data-testid="verify-email"
          data-verified={emailVerified}
          className="flex gap-3 rounded-lg border border-border bg-surface p-4"
        >
          <span
            className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
              emailVerified ? 'bg-success-soft text-success-text' : 'bg-info-soft text-info-text'
            }`}
          >
            <Icon name="mail" />
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <strong className="text-body-md">
              {t.t(emailVerified ? 'verify.email.done' : 'verify.email.waiting')}
            </strong>
            {emailHint !== null ? (
              <span className="text-body-sm text-text-2">{t.t('verify.sentTo', { hint: emailHint })}</span>
            ) : null}
          </div>
          <span
            className={`self-start rounded-full px-2 text-caption font-bold ${
              emailVerified ? 'bg-success-soft text-success-text' : 'bg-surface-sunken text-text-2'
            }`}
          >
            {t.t(emailVerified ? 'verify.status.done' : 'verify.status.waiting')}
          </span>
        </div>

        <form
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex gap-3">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text">
              <Icon name="sms" />
            </span>
            <div className="flex flex-col gap-1">
              <strong className="text-body-md">{t.t('verify.phone.title')}</strong>
              <span className="text-body-sm text-text-2">
                {phoneHint !== null ? (
                  <span dir="ltr" className="font-mono">
                    {t.t('verify.sentTo', { hint: phoneHint })}
                  </span>
                ) : null}{' '}
                <a href="/sign-up" className={LINK}>
                  {t.t('verify.phone.change')}
                </a>
              </span>
            </div>
          </div>

          <OtpInput
            value={code}
            onChange={setCode}
            groupLabel={t.t('auth.mfa.code.label')}
            digitLabel={(position) => t.t('auth.mfa.code.digit', { position })}
            invalid={error !== undefined && error.code.startsWith('otp_')}
            disabled={pending}
          />

          {error !== undefined || waitingForEmail ? (
            <div
              ref={alertRef}
              role="alert"
              tabIndex={-1}
              data-testid="verify-error"
              data-error-code={error?.code ?? 'verify_email'}
              className="flex gap-3 rounded-lg bg-danger-soft p-3 text-body-sm text-danger-text"
            >
              <Icon name={error?.code === 'otp_expired' ? 'timer_off' : 'error'} />
              <span className="flex flex-col gap-1">
                <strong>
                  {error !== undefined
                    ? t.t(`auth.error.${error.code}` as MessageId)
                    : t.t('verify.emailPending')}
                </strong>
                {typeof attempts === 'number' ? (
                  <span data-testid="otp-attempts">{t.t('auth.attemptsRemaining', { count: attempts })}</span>
                ) : null}
                {error?.retryAt !== undefined ? (
                  <span data-testid="otp-retry">
                    {t.t('auth.locked.retryAt', formatRetryTime(error.retryAt, error.timeZone, locale))}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          <ResendControl
            resendAt={resendAt}
            waitingLabel={(clock) => t.t('auth.mfa.resend.in', { clock })}
            nowLabel={t.t('auth.mfa.resend.now')}
            onResend={() => void resend()}
            disabled={pending}
            testIdPrefix="verify-resend"
          />

          <button
            type="submit"
            disabled={pending || code.length < CODE_LENGTH}
            data-testid="verify-submit"
            className={PRIMARY_BUTTON}
          >
            {t.t(pending ? 'auth.mfa.verifying' : 'verify.submit')}
          </button>
        </form>

        <p className="text-caption text-text-muted">{t.t('verify.help')}</p>
      </section>
    </AuthShell>
  );
}
