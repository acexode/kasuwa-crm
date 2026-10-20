'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Button, Checkbox } from '@kasuwa/ui/components';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { AUTH_COLUMN, ICON_DISC, PAGE_SUBTITLE, PAGE_TITLE, SECTION_LABEL } from './auth-classes';
import { LeadSentence } from './rich-text';
import { OtpInput } from './otp-input';
import { ResendControl } from './resend-control';
import {
  reissueMfaChallenge,
  verifyMfa,
  type MfaChallengeStarted,
  type MfaMethodType,
  type ScreenError,
} from '../../lib/auth-api';
import {
  browserSessionStore,
  forgetSmsOption,
  recallSmsOption,
  rememberSmsOption,
  smsOptionHint,
} from '../../lib/mfa-sms-option';
import {
  availableFallbacks,
  forgetFallbacks,
  recallFallbacks,
  rememberFallbacks,
  type MfaFallback,
} from '../../lib/mfa-fallbacks';
import type { LanguageOption } from './language-menu';

const CODE_LENGTH = 6;

export function MfaScreen({
  messages,
  locale,
  locales,
  challengeId,
  initialMethod,
  initialResendAvailableAt,
  landing,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
  challengeId: string;
  initialMethod: MfaMethodType;
  initialResendAvailableAt: string | null;
  /** Where a signed-in browser lands, decided on the server (`lib/server/landing.ts`). */
  landing: string;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();

  const [method, setMethod] = useState<MfaMethodType>(initialMethod);
  const [hint, setHint] = useState<string | null>(null);
  // The masked number "Text a code to …" offers, or `null` to hide it (T-0126).
  // Starts hidden on the server and on first paint; sessionStorage is read
  // after hydration, so a reload of /verify keeps the decision sign-in made.
  const [smsOffer, setSmsOffer] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<string | null>(initialResendAvailableAt);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);
  const alertRef = useRef<HTMLDivElement>(null);

  // Passkey and backup code, under the same rule (T-0131): hidden until the
  // challenge says the method is available.
  const [fallbacks, setFallbacks] = useState<readonly MfaFallback[]>([]);

  useEffect(() => {
    const remembered = recallSmsOption(browserSessionStore(), challengeId);
    setSmsOffer(remembered);
    setHint((current) => current ?? remembered);
    setFallbacks(recallFallbacks(browserSessionStore(), challengeId));
  }, [challengeId]);

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

      if (!expired && code.length < CODE_LENGTH) {
        // The button stays at full colour, as the board draws it; an
        // incomplete code is answered by putting the caret where the next
        // digit goes.
        const cells = document.querySelectorAll<HTMLInputElement>('[data-testid="otp-input"] input');
        cells[Math.min(code.length, CODE_LENGTH - 1)]?.focus();
        return;
      }

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
        forgetSmsOption(browserSessionStore(), challengeId);
        forgetFallbacks(browserSessionStore(), challengeId);
        // The BFF has set the session cookie (the body carries no token,
        // ADR-0019 point 3). Straight to the landing the server chose, with no
        // redirect hop on the way: a hop through `/` makes the router abort
        // the redirected request after its answer arrives, which is noise at
        // best (T-0125 gate). `replace`, so Back does not return to a spent
        // challenge.
        router.replace(landing);
        return;
      }
      setError(result.error);
    },
    [challengeId, code, expired, landing, method, pending, router],
  );

  function applyChallenge(challenge: MfaChallengeStarted) {
    setMethod(challenge.method);
    setResendAt(challenge.resendAvailableAt);
    setHint(challenge.methods.find((entry) => entry.type === challenge.method)?.deliveryHint ?? null);
    // Same rule as sign-in, so a reissue that withdraws SMS hides the option
    // here and after a reload. Keyed by the id in the URL, which is the one a
    // reload reads.
    const offer = smsOptionHint(challenge.methods);
    setSmsOffer(offer);
    rememberSmsOption(browserSessionStore(), challengeId, offer);
    const nextFallbacks = availableFallbacks(challenge.methods);
    setFallbacks(nextFallbacks);
    rememberFallbacks(browserSessionStore(), challengeId, nextFallbacks);
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
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
      <section data-screen={screenId} className={AUTH_COLUMN}>
        <span className={`${ICON_DISC} bg-primary-soft text-primary-text`}>
          <Icon name={expired ? 'timer_off' : method === 'sms' ? 'sms' : 'phone_iphone'} size={28} />
        </span>

        <div className="flex flex-col gap-1.5">
          <h1 className={PAGE_TITLE}>
            {t.t(
              expired
                ? 'auth.mfa.title.expired'
                : method === 'sms'
                  ? 'auth.mfa.title.sms'
                  : 'auth.mfa.title.app',
            )}
          </h1>
          <p className={`${PAGE_SUBTITLE} text-pretty`}>
            {method === 'sms'
              ? t.t('auth.mfa.body.sms', { hint: hint ?? '' })
              : t.t('auth.mfa.body.app')}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4.5" noValidate>
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
              className="flex gap-2 text-body-sm text-danger-text outline-offset-2"
            >
              <Icon name={expired ? 'timer_off' : 'error'} size={20} />
              <span>
                <LeadSentence text={t.t(`auth.error.${error.code}` as MessageId)} locale={locale} />
                {typeof attempts === 'number' ? (
                  <span> {t.t('auth.attemptsRemaining', { count: attempts })}</span>
                ) : null}
              </span>
            </div>
          ) : null}

          {method === 'sms' && !expired ? (
            <>
              <ResendControl
                resendAt={resendAt}
                waitingLabel={(clock) => t.t('auth.mfa.resend.in', { clock })}
                nowLabel={t.t('auth.mfa.resend.now')}
                onResend={() => void switchTo('sms')}
                disabled={pending}
              />
              <p className="text-meta text-text-muted">
                {t.t('auth.mfa.sms.slow')}{' '}
                <button
                  type="button"
                  className="rounded-sm font-bold text-primary-text underline-offset-2 hover:underline focus-visible:ring-focus"
                >
                  {t.t('auth.mfa.sms.voice')}
                </button>
              </p>
            </>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            size="large"
            loading={pending}
            data-testid="mfa-submit"
            className="w-full"
          >
            {t.t(expired ? 'auth.mfa.sendNew' : pending ? 'auth.mfa.verifying' : 'auth.mfa.verify')}
          </Button>
        </form>

        {method === 'totp' && !expired ? (
          <Checkbox name="trustDevice" label={t.t('auth.mfa.trustDevice')} />
        ) : null}

        <div className="flex flex-col border-t border-border pt-2">
          <h2 className={`${SECTION_LABEL} py-1.5`}>{t.t('auth.mfa.alternatives')}</h2>
          {method === 'totp' ? (
            <>
              {fallbacks.includes('passkey') ? (
                <AlternativeRow icon="passkey" label={t.t('auth.mfa.alt.passkey')} />
              ) : null}
              {smsOffer !== null ? (
                <AlternativeRow
                  icon="sms"
                  testId="switch-to-sms"
                  label={t.t('auth.mfa.alt.sms', { hint: smsOffer })}
                  onClick={() => void switchTo('sms')}
                />
              ) : null}
              {fallbacks.includes('backup_code') ? (
                <AlternativeRow
                  icon="key"
                  label={t.t('auth.mfa.alt.backup')}
                  onClick={() => void switchTo('backup_code')}
                />
              ) : null}
            </>
          ) : (
            <>
              <AlternativeRow
                icon="phone_iphone"
                testId="switch-to-app"
                label={t.t('auth.mfa.alt.app')}
                onClick={() => void switchTo('totp')}
              />
              {fallbacks.includes('passkey') ? (
                <AlternativeRow icon="passkey" label={t.t('auth.mfa.alt.passkey')} />
              ) : null}
            </>
          )}
        </div>
      </section>
    </AuthShell>
  );
}

/** One "Other ways to verify" row: a divided, full-width row with a chevron. */
function AlternativeRow({
  icon,
  label,
  testId,
  onClick,
}: {
  icon: IconName;
  label: string;
  testId?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex min-h-control-lg w-full items-center gap-3 border-b border-border text-start text-label font-normal text-text hover:bg-surface-sunken focus-visible:ring-focus"
    >
      <Icon name={icon} size={20} className="text-text-2" />
      <span className="flex-1">{label}</span>
      <Icon name="chevron_right" size={20} className="text-text-muted rtl:-scale-x-100" />
    </button>
  );
}
