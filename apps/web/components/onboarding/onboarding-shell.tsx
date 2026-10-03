'use client';

import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { LanguageMenu, type LanguageOption } from '../auth/language-menu';
import { LiteModeToggle } from '../auth/lite-mode';
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';

/**
 * The frame of the setup wizard, `P01/5.1`–`5.5`.
 *
 * Five steps on the board: data region, currency and language, WhatsApp,
 * import, team. Step 1 (`P01/5.1`) belongs to self-serve sign-up and sits
 * behind `self_serve_signup`; steps 2–5 are the first-admin-login flow every
 * tenant gets (D-P2, T-0018). The stepper still shows all five, because a
 * sales-provisioned tenant HAS a data region — it was chosen at provisioning —
 * so step 1 reads as done rather than vanishing and renumbering the rest.
 *
 * Desktop draws the stepper as an ordered list with `aria-current="step"`;
 * narrow screens get "Step n of 5" and a progress bar, as on the board. Both
 * are in the DOM and one is `display: none`, which also removes it from the
 * accessibility tree — a screen-reader user hears one, not both.
 */

export const STEP_KEYS = ['region', 'currency', 'whatsapp', 'import', 'team'] as const;
export type StepKey = (typeof STEP_KEYS)[number];

export interface FooterAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly testId?: string;
}

export function OnboardingShell({
  t,
  locales,
  locale,
  step,
  back,
  skip,
  next,
  children,
}: {
  t: Translator;
  locales: readonly LanguageOption[];
  locale: string;
  /** 1-based; `null` on the success screen, which has no stepper or footer. */
  step: number | null;
  back?: FooterAction | undefined;
  skip?: FooterAction | undefined;
  next?: FooterAction | undefined;
  children: ReactNode;
}) {
  const total = STEP_KEYS.length;
  const currentKey = step === null ? undefined : STEP_KEYS[step - 1];

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <header className="flex min-h-touch flex-shrink-0 items-center gap-2 border-b border-border px-5 py-2">
        <p className="flex items-center gap-2 text-body-lg font-bold">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-h5 font-extrabold text-accent"
          >
            K
          </span>
          <span>{t.t('app.name')}</span>
        </p>
        <span className="flex-1" />
        <LiteModeToggle
          label={t.t('auth.topbar.lite')}
          onLabel={t.t('auth.topbar.lite.on')}
          accessibleName={t.t('auth.topbar.lite.toggle')}
          compact={false}
        />
        <LanguageMenu
          options={locales}
          current={locale}
          label={t.t('auth.topbar.language')}
          currentLabel={t.t('auth.topbar.language.current', { language: t.t('auth.topbar.language') })}
          compact={false}
        />
      </header>

      {step !== null && currentKey !== undefined ? (
        <nav aria-label={t.t('onboarding.progress')} className="px-5 pt-6">
          <ol className="mx-auto hidden max-w-3xl list-none items-center gap-2 p-0 md:flex">
            {STEP_KEYS.map((key, index) => {
              const position = index + 1;
              const done = position < step;
              const current = position === step;
              return (
                <li key={key} className="flex flex-1 items-center gap-2 last:flex-none">
                  <span
                    aria-hidden="true"
                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-body-sm font-bold ${
                      done
                        ? 'bg-success-soft text-success-text'
                        : current
                          ? 'bg-primary text-on-primary'
                          : 'border-2 border-border-strong bg-surface text-text-2'
                    }`}
                  >
                    {done ? <Icon name="check" size="sm" /> : position}
                  </span>
                  <span
                    aria-current={current ? 'step' : undefined}
                    className={`text-body-sm ${current ? 'font-bold text-text' : 'text-text-2'}`}
                  >
                    <span className="sr-only">{t.t('onboarding.stepOf', { current: position, total })} </span>
                    {t.t(`onboarding.step.${key}`)}
                  </span>
                  {position < total ? (
                    <span aria-hidden="true" className={`h-1 flex-1 ${done ? 'bg-success' : 'bg-border'}`} />
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="flex flex-col gap-2 md:hidden">
            <p className="text-body-sm text-text-2">
              <strong className="text-text">{t.t('onboarding.stepOf', { current: step, total })}</strong>
              {' · '}
              {t.t(`onboarding.step.${currentKey}`)}
            </p>
            <div
              role="progressbar"
              aria-label={t.t('onboarding.progress')}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={step}
              className="grid grid-cols-5 gap-1"
            >
              {STEP_KEYS.map((key, index) => (
                <span
                  key={key}
                  className={`h-1 rounded-full ${
                    index + 1 < step ? 'bg-success' : index + 1 === step ? 'bg-primary' : 'bg-border'
                  }`}
                />
              ))}
            </div>
          </div>
        </nav>
      ) : null}

      <div className="flex flex-1 flex-col items-center px-5 pb-10 pt-8">{children}</div>

      {back !== undefined || skip !== undefined || next !== undefined ? (
        <footer className="sticky bottom-0 flex flex-shrink-0 items-center gap-2 border-t border-border bg-surface px-5 py-3">
          {back !== undefined ? (
            <button type="button" onClick={back.onClick} className={QUIET_BUTTON}>
              <Icon name="arrow_back" size="sm" className="rtl:-scale-x-100" />
              {back.label}
            </button>
          ) : null}
          <span className="flex-1" />
          {skip !== undefined ? (
            <button type="button" onClick={skip.onClick} data-testid={skip.testId} className={SECONDARY_BUTTON}>
              {skip.label}
            </button>
          ) : null}
          {next !== undefined ? (
            <button type="button" onClick={next.onClick} data-testid={next.testId} className={PRIMARY_BUTTON}>
              {next.label}
            </button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

/** The heading block every step opens with. */
export function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-2">
      {/* tabIndex -1: the wizard moves focus here when the step changes. */}
      <h1 tabIndex={-1} className="text-h3 text-text">
        {title}
      </h1>
      <p className="text-body-md text-text-2">{subtitle}</p>
    </div>
  );
}
