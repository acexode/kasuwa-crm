'use client';

import { useId, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button, EmptyState, Stepper } from '@kasuwa/ui/components';
import type { IconName } from '@kasuwa/ui';
import type { LanguageOption } from '../auth/language-menu';
import { Icon } from '../icon';
import { BarStatus, DataHeader, DataShell, type DataLive, type DataSection } from './data-shell';
import { CARD, CARD_TITLE, StatTile, TABLE_CARD, TABLE_HEAD } from './parts';

/**
 * P28's three sections with no backend yet (T-0141, D-L194): Migration (B),
 * the Export centre (D) and Data-subject requests (E). Each is the design's
 * own screen in its empty or disabled state, behind its own flag
 * (`data_migration`, `data_export`, `dsr`): the same layout, columns and
 * actions, with no job, export, request or number that nobody served. Every
 * action that would need the module is disabled and says it is not available
 * yet.
 */

interface FrameProps {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  bell: boolean;
  sections: DataLive;
}

function Frame({ t, props, current, footer, children }: { t: Translator; props: FrameProps; current: DataSection; footer?: ReactNode; children: ReactNode }) {
  return (
    <DataShell t={t} locale={props.locale} messages={props.messages} locales={props.locales} bell={props.bell} current={current} live={props.sections} footer={footer}>
      {children}
    </DataShell>
  );
}

const SOON = 'data.soon';

/** B: Connect, the first of the migration's five steps, not connected. */
export function MigrationPlaceholder(props: FrameProps) {
  const t = createBundleTranslator(props.locale, props.messages);
  const id = useId();
  const steps = (['connect', 'choose', 'mapping', 'dryRun', 'migrate'] as const).map((step, index) => ({
    label: t.t(`data.migration.step.${step}` as MessageId),
    state: index === 0 ? ('active' as const) : ('todo' as const),
  }));
  const promises: readonly [IconName, MessageId][] = [
    ['visibility', 'data.migration.read'],
    ['edit_off', 'data.migration.noWrite'],
    ['link_off', 'data.migration.disconnect'],
  ];
  return (
    <Frame
      t={t}
      props={props}
      current="migration"
      footer={
        <>
          <BarStatus icon="info">{t.t('data.migration.bar')}</BarStatus>
          <Button variant="primary" disabled trailingIcon="arrow_forward">
            {t.t('data.migration.next')}
          </Button>
        </>
      }
    >
      <div data-screen="P28/B" className="flex min-w-0 flex-col gap-5">
        <DataHeader title={t.t('data.migration.title')} lede={t.t('data.migration.lede')}>
          <Stepper steps={steps} label={t.t('import.steps.label')} compactSummary={t.t('import.steps.compact', { step: 1, total: 5, label: steps[0]?.label ?? '' })} />
        </DataHeader>
        <div role="radiogroup" aria-label={t.t('data.migration.source')} className="grid gap-3.5 xl:grid-cols-2">
          {(['zoho', 'salesforce'] as const).map((source, index) => (
            <label
              key={source}
              className={`flex min-h-control-xl items-center gap-3.5 rounded-lg px-4 py-4 ${index === 0 ? 'border-2 border-primary bg-primary-soft' : 'border border-border bg-surface'}`}
            >
              <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-body-md font-extrabold">
                {t.t(`data.migration.${source}.initial` as MessageId)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <b className="text-body-md font-bold">{t.t(`data.migration.${source}` as MessageId)}</b>
                <span className="text-meta text-text-2">{t.t(`data.migration.${source}.body` as MessageId)}</span>
              </span>
              <span className="relative flex size-4.5 shrink-0 items-center justify-center">
                <input type="radio" name={`${id}-source`} defaultChecked={index === 0} className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-full border-2 border-border-strong checked:border-primary focus-visible:ring-focus" />
                <span aria-hidden="true" className="pointer-events-none hidden size-2 rounded-full bg-primary peer-checked:block" />
              </span>
            </label>
          ))}
        </div>
        <section className={CARD} aria-labelledby={`${id}-connect`}>
          <h2 id={`${id}-connect`} className={CARD_TITLE}>
            {t.t('data.migration.connect.title')}
          </h2>
          <p className="m-0 max-w-[660px] text-body-relaxed text-text-2">{t.t('data.migration.connect.body')}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {promises.map(([icon, label]) => (
              <li key={label} className="flex items-center gap-2.5 text-body-sm">
                <Icon name={icon} size={20} className="text-success-text" />
                {t.t(label)}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" icon="link" disabled title={t.t(SOON)}>
              {t.t('data.migration.connect.action')}
            </Button>
            <span className="text-meta text-text-muted">{t.t(SOON)}</span>
          </div>
        </section>
      </div>
    </Frame>
  );
}

const EXPORT_FILTERS = ['all', 'waiting', 'ready', 'rejected', 'expired'] as const;

/** D: the Export centre, with no exports. */
export function ExportsPlaceholder(props: FrameProps) {
  const t = createBundleTranslator(props.locale, props.messages);
  return (
    <Frame t={t} props={props} current="exports">
      <div data-screen="P28/D" className="flex min-w-0 flex-col gap-5">
        <DataHeader
          title={t.t('data.exports.title')}
          lede={t.t('data.exports.lede')}
          action={
            <Button variant="primary" icon="add" disabled title={t.t(SOON)}>
              {t.t('data.exports.new')}
            </Button>
          }
        />
        <div role="group" aria-label={t.t('data.exports.filter')} className="flex flex-wrap gap-1.5">
          {EXPORT_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={filter === 'all'}
              disabled={filter !== 'all'}
              className={`inline-flex h-control-sm items-center rounded-full border px-3 text-meta font-semibold ${
                filter === 'all' ? 'border-primary bg-primary text-on-primary' : 'cursor-not-allowed border-border bg-surface text-disabled-text'
              }`}
            >
              {t.t(`data.exports.filter.${filter}` as MessageId)}
            </button>
          ))}
        </div>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className={`${TABLE_CARD} px-5 py-6`}>
            <EmptyState icon="download" tone="neutral" headingLevel={2} title={t.t('data.exports.empty.title')} body={t.t('data.exports.empty.body')} />
          </div>
          <aside className={`${CARD} hidden xl:flex`} aria-label={t.t('data.exports.detail')}>
            <EmptyState icon="lock" tone="neutral" headingLevel={2} title={t.t('data.exports.detail.title')} body={t.t('data.exports.detail.body')} />
          </aside>
        </div>
      </div>
    </Frame>
  );
}

const DSR_TILES = ['open', 'due', 'overdue', 'completed'] as const;
const DSR_GRID = 'md:grid md:grid-cols-[minmax(0,1.3fr)_130px_110px_minmax(0,1fr)_170px] md:gap-3.5';

/** E: Data-subject requests, with none logged. */
export function RequestsPlaceholder(props: FrameProps) {
  const t = createBundleTranslator(props.locale, props.messages);
  return (
    <Frame t={t} props={props} current="requests">
      <div data-screen="P28/E" className="flex min-w-0 flex-col gap-5">
        <DataHeader
          title={t.t('data.requests.title')}
          lede={t.t('data.requests.lede')}
          action={
            <Button variant="primary" icon="add" disabled title={t.t(SOON)}>
              {t.t('data.requests.log')}
            </Button>
          }
        />
        <dl className="m-0 grid grid-cols-2 gap-3.5 xl:grid-cols-4">
          {DSR_TILES.map((tile) => (
            <StatTile key={tile} label={t.t(`data.requests.tile.${tile}` as MessageId)} value={<span aria-label={t.t('data.requests.none')}>—</span>} />
          ))}
        </dl>
        <div className={TABLE_CARD}>
          <div aria-hidden="true" className={`${TABLE_HEAD} hidden ${DSR_GRID}`}>
            <span>{t.t('data.requests.col.request')}</span>
            <span>{t.t('data.requests.col.type')}</span>
            <span>{t.t('data.requests.col.received')}</span>
            <span>{t.t('data.requests.col.stage')}</span>
            <span>{t.t('data.requests.col.left')}</span>
          </div>
          <div className="px-5 py-6">
            <EmptyState icon="privacy_tip" tone="neutral" headingLevel={2} title={t.t('data.requests.empty.title')} body={t.t('data.requests.empty.body')} />
          </div>
        </div>
      </div>
    </Frame>
  );
}
