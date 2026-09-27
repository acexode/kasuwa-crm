import {
  COLOUR_SCALES,
  contrastRatio,
  RADIUS,
  SEMANTIC_CONTRAST_PAIRS,
  SEMANTIC_LIGHT,
  SPACING,
  TYPE_SCALE,
  type ColourFamily,
  type ToneKey,
} from '@kasuwa/ui';
import { createTranslator } from '@kasuwa/i18n';

/**
 * The design-tokens page: the whole of apps/web in the scaffold.
 *
 * It is here to prove three things end to end, not to look finished:
 *   1. tokens flow from packages/ui through the Tailwind preset into rendered CSS
 *   2. every user-facing string goes through @kasuwa/i18n (the lint rule fails
 *      the build otherwise)
 *   3. the contrast ratios asserted in tests are visible to a human reviewer
 */
export default function TokensPage() {
  const t = createTranslator('en-NG');
  const families = Object.keys(COLOUR_SCALES) as ColourFamily[];
  const tones = Object.keys(COLOUR_SCALES.primary) as ToneKey[];

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-10">
        <p className="text-caption uppercase text-text-muted">{t.t('app.name')}</p>
        <h1 className="text-h1 text-text-primary">{t.t('tokens.page.title')}</h1>
        <p className="mt-2 text-body-lg text-text-secondary">{t.t('tokens.page.subtitle')}</p>
        <p className="mt-4 rounded-md border border-warning-300 bg-warning-50 p-4 text-body-sm text-warning-900">
          {t.t('tokens.provisional.notice')}
        </p>
      </header>

      <section className="mb-12">
        <h2 className="mb-4 text-h2 text-text-primary">{t.t('tokens.section.colour')}</h2>
        <div className="space-y-4">
          {families.map((family) => (
            <div key={family}>
              <p className="mb-1 text-h6 text-text-secondary">{family}</p>
              <div className="flex flex-wrap gap-1">
                {tones.map((tone) => (
                  <div key={tone} className="w-16">
                    <div
                      className="h-10 rounded-sm border border-border"
                      style={{ backgroundColor: COLOUR_SCALES[family][tone] }}
                    />
                    <p className="mt-1 text-caption text-text-muted">{tone}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-h2 text-text-primary">{t.t('tokens.section.semantic')}</h2>
        <ul className="space-y-2">
          {SEMANTIC_CONTRAST_PAIRS.map((pair) => {
            const ratio = contrastRatio(
              SEMANTIC_LIGHT[pair.foreground],
              SEMANTIC_LIGHT[pair.background],
            );
            return (
              <li
                key={`${pair.foreground}-${pair.background}`}
                className="flex items-center justify-between rounded-md border border-border bg-surface-raised px-4 py-3"
              >
                <span className="text-body-md text-text-primary">{pair.foreground}</span>
                <span className="font-mono text-body-sm text-text-muted">
                  {t.t('tokens.contrast.label', {
                    ratio: ratio.toFixed(2),
                    background: pair.background,
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-h2 text-text-primary">{t.t('tokens.section.type')}</h2>
        <div className="space-y-3">
          {(Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[]).map((step) => (
            <div key={step} className="border-b border-border pb-3">
              <p className="text-caption text-text-muted">{step}</p>
              <p
                style={{ fontSize: TYPE_SCALE[step].size, lineHeight: TYPE_SCALE[step].lineHeight }}
              >
                {t.t('tokens.sample.text')}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-h2 text-text-primary">{t.t('tokens.section.spacing')}</h2>
        <div className="space-y-1">
          {Object.entries(SPACING).map(([name, value]) => (
            <div key={name} className="flex items-center gap-3">
              <span className="w-16 font-mono text-caption text-text-muted">{name}</span>
              <span className="block h-3 bg-primary-400" style={{ width: value }} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-h2 text-text-primary">{t.t('tokens.section.radius')}</h2>
        <div className="flex flex-wrap gap-4">
          {Object.entries(RADIUS).map(([name, value]) => (
            <div key={name} className="text-center">
              <div
                className="h-16 w-16 border border-border-strong bg-surface-raised"
                style={{ borderRadius: value }}
              />
              <p className="mt-1 text-caption text-text-muted">{name}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
