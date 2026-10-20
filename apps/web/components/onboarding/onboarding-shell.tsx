'use client';

import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { AuthTopBar } from '../auth/auth-shell';
import { PAGE_SUBTITLE, PAGE_TITLE } from '../auth/auth-classes';

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
  /** The phone top bar's one-word form ("Skip"). */
  readonly shortLabel?: string;
  /** Drawn in place but not usable (Back to a step this tenant cannot reach). */
  readonly disabled?: boolean;
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
  /** 1-based. */
  step: number;
  back?: FooterAction | undefined;
  skip?: FooterAction | undefined;
  next?: FooterAction | undefined;
  children: ReactNode;
}) {
  const total = STEP_KEYS.length;
  const currentKey = STEP_KEYS[step - 1];

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text">
      <AuthTopBar
        strings={{
          brand: t.t('app.name'),
          languageLabel: t.t('auth.topbar.language'),
          languageCurrent: t.t('auth.topbar.language.current', { language: t.t('auth.topbar.language') }),
          liteLabel: t.t('auth.topbar.lite'),
          liteOnLabel: t.t('auth.topbar.lite.on'),
          liteToggleName: t.t('auth.topbar.lite.toggle'),
        }}
        locales={locales}
        currentLocale={locale}
        logo="always"
        bordered
        extra={
          // On a phone, "Skip" moves up to the top bar, as the board draws it.
          skip === undefined ? null : (
            <button
              type="button"
              onClick={skip.onClick}
              className="h-control-base whitespace-nowrap rounded-md px-2.5 text-body-sm font-semibold text-primary-text focus-visible:ring-focus md:hidden"
            >
              {skip.shortLabel ?? skip.label}
            </button>
          )
        }
      />

      <div className="flex flex-1 flex-col items-center px-5 pb-10 pt-8">
        {currentKey !== undefined ? (
          <nav aria-label={t.t('onboarding.progress')} className="w-full">
            <ol className="mx-auto mb-10 hidden w-full max-w-layout-wizard-stepper list-none items-center gap-2.5 p-0 md:flex">
              {STEP_KEYS.map((key, index) => {
                const position = index + 1;
                const done = position < step;
                const current = position === step;
                return (
                  <li
                    key={key}
                    className={`flex items-center gap-2.5 ${position < total ? 'flex-auto' : 'flex-none'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-7 flex-shrink-0 items-center justify-center rounded-full text-meta font-bold ${
                        done
                          ? 'bg-success text-on-primary'
                          : current
                            ? 'bg-primary text-on-primary'
                            : 'border-2 border-border-strong bg-surface text-text-2'
                      }`}
                    >
                      {done ? <Icon name="check" size={18} /> : position}
                    </span>
                    <span
                      aria-current={current ? 'step' : undefined}
                      className={`whitespace-nowrap text-body-sm ${current ? 'font-bold text-text' : 'font-medium text-text-2'}`}
                    >
                      <span className="sr-only">{t.t('onboarding.stepOf', { current: position, total })} </span>
                      {t.t(`onboarding.step.${key}`)}
                    </span>
                    {position < total ? (
                      <span
                        aria-hidden="true"
                        className={`h-0.5 min-w-4 flex-1 rounded-full ${done ? 'bg-success' : 'bg-border'}`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <div className="mb-6 flex flex-col gap-2 md:hidden">
              <p className="text-meta text-text-2">
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
                    className={`h-1.5 rounded-full ${
                      index + 1 < step ? 'bg-success' : index + 1 === step ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                ))}
              </div>
            </div>
          </nav>
        ) : null}

        {children}
      </div>

      {back !== undefined || skip !== undefined || next !== undefined ? (
        <footer className="sticky bottom-0 flex flex-shrink-0 items-center gap-2 border-t border-border bg-surface px-5 pb-4 pt-3">
          {back !== undefined ? (
            <Button size="large" onClick={back.onClick} disabled={back.disabled}>
              <Icon name="arrow_back" size={20} className="rtl:-scale-x-100" />
              {back.label}
            </Button>
          ) : null}
          <span className="flex-1" />
          {skip !== undefined ? (
            <Button
              variant="ghost"
              size="large"
              onClick={skip.onClick}
              data-testid={skip.testId}
              className="max-md:hidden"
            >
              {skip.label}
            </Button>
          ) : null}
          {next !== undefined ? (
            <Button variant="primary" size="large" onClick={next.onClick} data-testid={next.testId} className="min-w-36">
              {next.label}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

/** The heading block every step opens with. */
export function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* tabIndex -1: the wizard moves focus here when the step changes. */}
      <h1 tabIndex={-1} className={PAGE_TITLE}>
        {title}
      </h1>
      <p className={`${PAGE_SUBTITLE} text-pretty`}>{subtitle}</p>
    </div>
  );
}
