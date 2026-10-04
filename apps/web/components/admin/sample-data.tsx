import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';

/**
 * The frame around a panel that shows SAMPLE data (T-0035): KPIs on `P02/B2`
 * and skill cover on `P02/B3`, the two reads the admin API cannot answer yet.
 * See `lib/admin-sample.ts` for where the numbers come from and why.
 *
 * `data-source="mock"` is the machine-readable half and the visible note is
 * the human half. The note is TEXT, translated, and sits above the figures —
 * a colour or an icon alone is not a label, and a label below the fold is one
 * nobody reads before acting on the number.
 */
export function SampleData({
  t,
  testId,
  children,
}: {
  t: Translator;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-source="mock"
      data-testid={testId}
      aria-label={t.t('admin.sample.label')}
      className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong p-3"
    >
      <p
        data-testid="sample-data-label"
        className="flex flex-wrap items-center gap-2 text-body-sm text-text-2"
      >
        <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 text-caption font-bold text-warning-text">
          <Icon name="info" size="sm" />
          {t.t('admin.sample.label')}
        </span>
        <span>{t.t('admin.sample.note')}</span>
      </p>
      {children}
    </section>
  );
}
