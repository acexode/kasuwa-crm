import {
  CHART_TOKENS,
  COLOUR_SCALES,
  CONTRAST_PAIRS,
  contrastRatio,
  CSS_VAR_PREFIX,
  DESIGN_VERSION,
  ELEVATION,
  FONT_FAMILIES,
  MOTION,
  MOTION_EASING,
  RADIUS,
  SCALE_ANCHORS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SEMANTIC_TOKEN_NAMES,
  SPACING,
  TYPE_SCALE,
  type ColourFamily,
  type SemanticToken,
  type ToneKey,
} from '@kasuwa/ui';
import { createTranslator } from '@kasuwa/i18n';

/**
 * The design-tokens page.
 *
 * Everything here is derived from the token source — the scales, both semantic
 * token sets, the type scale, spacing, radius, elevation, motion and the chart
 * palette are all iterated, never listed. That is the point: if a token is
 * added to the export and imported, it appears here without anyone editing
 * this file, and if one is removed it disappears. A page that hard-codes what
 * it shows stops being a mirror of the system and becomes a second thing to
 * keep up to date.
 *
 * It renders both themes side by side rather than following the viewer's
 * preference, because the job of this page is reviewing the system, and half a
 * system is not reviewable.
 */

const THEMES: readonly (readonly [
  SemanticToken extends never ? never : string,
  Record<string, string>,
])[] = [
  ['light', SEMANTIC_LIGHT],
  ['dark', SEMANTIC_DARK],
];

function isHex(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

export default function TokensPage() {
  const t = createTranslator('en-NG');
  const families = Object.keys(COLOUR_SCALES) as ColourFamily[];
  const tones = Object.keys(COLOUR_SCALES.primary) as ToneKey[];

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <header className="mb-12">
        <p className="text-caption uppercase tracking-wide text-text-muted">{t.t('app.name')}</p>
        <h1 className="text-h1 text-text">{t.t('tokens.page.title')}</h1>
        <p className="mt-2 text-body-lg text-text-2">
          {t.t('tokens.page.subtitle', { version: DESIGN_VERSION })}
        </p>
        <p className="mt-4 rounded-lg border border-info bg-info-soft p-4 text-body-sm text-info-text">
          {t.t('tokens.approved.notice')}
        </p>
      </header>

      {/* ---------------- colour scales ---------------- */}
      <section className="mb-12">
        <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.colour')}</h2>
        <div className="space-y-5">
          {families.map((family) => (
            <div key={family}>
              <p className="mb-1 text-h6 text-text-2">{family}</p>
              <div className="flex flex-wrap gap-1">
                {tones.map((tone) => (
                  <div key={tone} className="w-[4.5rem]">
                    <div
                      className="h-11 rounded-sm border border-border"
                      style={{ backgroundColor: COLOUR_SCALES[family][tone] }}
                    />
                    <p className="mt-1 font-mono text-caption text-text-muted">
                      {tone}
                      {SCALE_ANCHORS[family] === Number(tone) ? ' ★' : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- semantic tokens, both themes ---------------- */}
      <section className="mb-12">
        <h2 className="mb-1 text-h3 text-text">{t.t('tokens.section.semantic')}</h2>
        <p className="mb-4 text-body-sm text-text-muted">
          {t.t('tokens.count', { count: SEMANTIC_TOKEN_NAMES.length })}
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[34rem] border-collapse text-body-sm">
            <thead>
              <tr className="bg-surface-sunken text-left">
                <th className="p-3 font-semibold text-text-2">{CSS_VAR_PREFIX}</th>
                <th className="p-3 font-semibold text-text-2">{t.t('tokens.theme.light')}</th>
                <th className="p-3 font-semibold text-text-2">{t.t('tokens.theme.dark')}</th>
              </tr>
            </thead>
            <tbody>
              {SEMANTIC_TOKEN_NAMES.map((token) => (
                <tr key={token} className="border-t border-border">
                  <td className="p-3 font-mono text-text">{token}</td>
                  {THEMES.map(([themeName, theme]) => (
                    <td key={themeName} className="p-3">
                      <span className="flex items-center gap-2">
                        {isHex(theme[token] ?? '') ? (
                          <span
                            className="inline-block h-5 w-5 shrink-0 rounded-sm border border-border-strong"
                            style={{ backgroundColor: theme[token] }}
                          />
                        ) : null}
                        <span className="font-mono text-caption text-text-muted">
                          {theme[token]}
                        </span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- contrast contract ---------------- */}
      <section className="mb-12">
        <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.contrast')}</h2>
        <div className="space-y-2">
          {CONTRAST_PAIRS.map((pair) => (
            <div
              key={`${pair.foreground}-${pair.background}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-4 py-3"
            >
              <span className="font-mono text-body-sm text-text">
                {pair.foreground} / {pair.background}
              </span>
              <span className="flex items-center gap-3">
                {THEMES.map(([themeName, theme]) => {
                  // Both tokens are guaranteed present: assertContrastPairsAreValid
                  // is asserted in the unit suite, and the importer enforces that
                  // light and dark carry identical key sets.
                  const foreground = theme[pair.foreground] ?? '';
                  const background = theme[pair.background] ?? '';
                  const ratio = contrastRatio(foreground, background);
                  return (
                    <span
                      key={themeName}
                      className="rounded-sm px-2 py-1 font-mono text-caption"
                      style={{ backgroundColor: background, color: foreground }}
                    >
                      {t.t('tokens.contrast.ratio', { ratio: ratio.toFixed(2) })}
                    </span>
                  );
                })}
                <span className="font-mono text-caption text-text-muted">
                  {t.t('tokens.contrast.minimum', { minimum: pair.minimumRatio })}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- typefaces ---------------- */}
      <section className="mb-12">
        <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.fonts')}</h2>
        <div className="space-y-3">
          {(Object.keys(FONT_FAMILIES) as (keyof typeof FONT_FAMILIES)[]).map((name) => (
            <div key={name} className="rounded-lg border border-border bg-surface p-4">
              <p className="font-mono text-caption text-text-muted">{name}</p>
              <p
                className="mt-1 text-body-lg text-text"
                style={{ fontFamily: FONT_FAMILIES[name] }}
                dir={name === 'arabic' ? 'rtl' : undefined}
                lang={name === 'arabic' ? 'ar' : undefined}
              >
                {name === 'arabic' ? t.t('tokens.sample.arabic') : t.t('tokens.sample.text')}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- type scale ---------------- */}
      <section className="mb-12">
        <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.type')}</h2>
        <div className="space-y-3">
          {(Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[]).map((step) => {
            const spec = TYPE_SCALE[step];
            return (
              <div key={step} className="border-b border-border pb-3">
                <p className="font-mono text-caption text-text-muted">
                  {step} · {spec.size}/{spec.lineHeight} · {spec.weight}
                </p>
                <p
                  className="text-text"
                  style={{
                    fontSize: spec.size,
                    lineHeight: spec.lineHeight,
                    fontWeight: Number(spec.weight),
                    letterSpacing: spec.tracking,
                    textTransform: 'transform' in spec ? spec.transform : undefined,
                    fontFamily: step === 'mono' ? FONT_FAMILIES.mono : undefined,
                  }}
                >
                  {t.t('tokens.sample.text')}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------------- spacing, radius ---------------- */}
      <div className="mb-12 grid gap-8 sm:grid-cols-2">
        <section>
          <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.spacing')}</h2>
          <div className="space-y-1">
            {Object.entries(SPACING).map(([name, value]) => (
              <div key={name} className="flex items-center gap-3">
                <span className="w-16 font-mono text-caption text-text-muted">{name}</span>
                <span className="w-12 font-mono text-caption text-text-muted">{value}</span>
                <span className="block h-3 bg-primary" style={{ width: value }} />
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.radius')}</h2>
          <div className="flex flex-wrap gap-4">
            {Object.entries(RADIUS).map(([name, value]) => (
              <div key={name} className="text-center">
                <div
                  className="h-16 w-16 border-2 border-primary bg-surface"
                  style={{ borderRadius: value }}
                />
                <p className="mt-1 font-mono text-caption text-text-muted">
                  {name} {value}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ---------------- elevation, motion ---------------- */}
      <div className="mb-12 grid gap-8 sm:grid-cols-2">
        <section>
          <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.elevation')}</h2>
          <div className="space-y-4 rounded-lg bg-surface-sunken p-4">
            {Object.entries(ELEVATION).map(([level, spec]) => (
              <div
                key={level}
                className="flex h-14 items-center rounded-md border border-border bg-surface px-4 font-mono text-body-sm text-text"
                style={{ boxShadow: spec.shadow }}
              >
                {level} · {spec.use}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.motion')}</h2>
          <div className="space-y-2">
            {Object.entries(MOTION).map(([name, spec]) => (
              <div
                key={name}
                className="flex items-baseline gap-3 rounded-md border border-border bg-surface px-4 py-3"
              >
                <span className="w-20 font-mono text-body-sm text-text">{name}</span>
                <span className="w-16 font-mono text-caption text-text-muted">{spec.duration}</span>
                <span className="text-body-sm text-text-2">{spec.use}</span>
              </div>
            ))}
            <div className="rounded-md border border-border bg-surface px-4 py-3">
              <span className="text-body-sm text-text-2">{t.t('tokens.motion.easing')} </span>
              <span className="font-mono text-caption text-text-muted">{MOTION_EASING}</span>
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- chart palette ---------------- */}
      <section>
        <h2 className="mb-4 text-h3 text-text">{t.t('tokens.section.chart')}</h2>
        <div className="flex flex-wrap gap-2">
          {CHART_TOKENS.map((token, index) => (
            <div key={token} className="w-28">
              <div
                className="h-12 rounded-md border border-border"
                style={{ backgroundColor: SEMANTIC_LIGHT[token] }}
              />
              <p className="mt-1 text-caption text-text-muted">
                {t.t('tokens.chart.series', { n: index + 1 })}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
