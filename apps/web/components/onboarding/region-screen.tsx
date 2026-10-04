'use client';

import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { LanguageOption } from '../auth/language-menu';
import { OnboardingShell, StepHeading } from './onboarding-shell';

/**
 * `P01/5.1` — where the tenant's data lives. Behind `self_serve_signup`.
 *
 * ---------------------------------------------------------------------------
 * ONLY SOUTH AFRICA IS SELECTABLE HERE, AND THAT IS A DECISION, NOT A GAP.
 *
 * D-P2: self-serve residency is limited to ZA; Nigeria and Kenya are
 * sales-only. The board draws three selectable cards. Here Nigeria and Kenya
 * are still SHOWN — someone who needs Nigerian residency must learn that it
 * exists and how to get it — but they are disabled radios carrying a "Talk to
 * sales" tag in place of the board's "Enterprise" / "Included".
 *
 * The NDPA panel is the designer's wording, verbatim, and is regulatory copy:
 * T-0007 says anything beyond the words in the export goes to counsel, not to
 * a paraphrase. Its last sentence ("choose Nigeria") now points at an option
 * this screen cannot select; that conflict is raised in team/reports/T-0007b.md
 * rather than resolved by rewording a legal explanation.
 *
 * There is no region field in `SignUpRequest`, so the choice is not sent
 * anywhere yet. T-0016 owns where it goes.
 * ---------------------------------------------------------------------------
 */

const REGIONS = [
  { key: 'za', latencyMs: 38, selfServe: true },
  { key: 'ng', latencyMs: 9, selfServe: false },
  { key: 'ke', latencyMs: 61, selfServe: false },
] as const;

export function RegionScreen({
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
  const latency = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'millisecond',
    unitDisplay: 'short',
  });

  return (
    <OnboardingShell
      t={t}
      locales={locales}
      locale={locale}
      step={1}
      next={{
        label: t.t('onboarding.continue'),
        onClick: () => router.push('/onboarding'),
        testId: 'onboarding-continue',
      }}
    >
      <section data-screen="P01/5.1" className="flex w-full max-w-2xl flex-col gap-5">
        <StepHeading title={t.t('region.title')} subtitle={t.t('region.subtitle')} />

        <div
          role="radiogroup"
          aria-label={t.t('onboarding.step.region')}
          className="flex flex-col gap-3"
        >
          {REGIONS.map((region) => {
            const checked = region.selfServe;
            return (
              <div
                key={region.key}
                role="radio"
                aria-checked={checked}
                aria-disabled={!region.selfServe}
                tabIndex={checked ? 0 : -1}
                data-region={region.key}
                className={`flex min-h-touch items-center gap-3 rounded-lg p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                  checked
                    ? 'border-2 border-primary bg-primary-soft'
                    : 'border border-border-strong bg-surface'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${
                    checked ? 'border-primary' : 'border-border-strong'
                  }`}
                >
                  {checked ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
                </span>
                <span className="flex flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong className="text-body-md text-text">
                      {t.t(`region.${region.key}.name` as MessageId)}
                    </strong>
                    <span
                      className={`rounded-full px-2 text-caption font-bold ${
                        region.selfServe
                          ? 'bg-success-soft text-success-text'
                          : 'bg-accent-soft text-accent-text'
                      }`}
                    >
                      {t.t(region.selfServe ? 'region.tag.default' : 'region.tag.sales')}
                    </span>
                  </span>
                  <span className="text-body-sm text-text-2">
                    {t.t(`region.${region.key}.desc` as MessageId)}
                  </span>
                  {region.selfServe ? null : (
                    <span className="text-body-sm text-text-2">{t.t('region.sales.note')}</span>
                  )}
                </span>
                <span dir="ltr" className="font-mono text-caption text-text-muted">
                  {`~${latency.format(region.latencyMs)}`}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex gap-3 rounded-lg bg-surface-sunken p-4">
          <Icon name="info" className="text-text-2" />
          <div className="flex flex-col gap-2">
            <strong className="text-body-md">{t.t('region.law.title')}</strong>
            {/* D-P11: the design's last sentence told the reader to "choose
                Nigeria", which D-P2 makes unselectable here. It is replaced by
                the adopted sales sentence, under NEW ids so every catalogue had
                to say the new thing. Counsel signs off the final wording before
                self_serve_signup is lifted. */}
            <span data-testid="region-law" className="text-body-sm text-text-2">
              {t.t('region.law.guidance')}
            </span>
            <span data-testid="region-law-sales" className="text-body-sm font-semibold text-text">
              {t.t('region.law.sales')}
            </span>
            <span className="text-caption text-text-muted">{t.t('region.law.disclaimer')}</span>
          </div>
        </div>
      </section>
    </OnboardingShell>
  );
}
