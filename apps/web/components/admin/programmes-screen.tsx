'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel } from './panel';
import { useResource } from './use-resource';
import type { LanguageOption } from '../auth/language-menu';
import { Pill, type PillTone } from '@kasuwa/ui/components';
import { AdminButton, CARD, ChipCount, PageHeader, SearchField, TABLE_HEAD, chipClass } from './admin-ui';
import {
  listProgrammes,
  type Programme,
  type ProgrammeChannel,
  type ProgrammeStatus,
} from '../../lib/admin-api';
import { formatCount, formatCountry, formatPercent } from '../../lib/admin-format';

/**
 * `P02/B` — the programmes list — and `P02/B1`, the first-run empty state.
 *
 * ---------------------------------------------------------------------------
 * "NO PROGRAMMES" AND "NONE OF THEM ARE YOURS" LOOK THE SAME, DELIBERATELY.
 *
 * The contract says the list is the caller's reachable set and nothing else:
 * there is no `programmeIds` argument, because `user_programme` decides inside
 * the tenant transaction. A caller with no programmes and a caller who cannot
 * reach any of the programmes that exist both get an empty list, and this
 * screen must not try to tell them apart. Doing so would turn the empty state
 * into an existence oracle for another programme's records.
 * ---------------------------------------------------------------------------
 *
 * The search and the status chips go to the SERVER (`q`, `status`), not to a
 * client-side filter over one page. A BPO with 300 programmes paginates, and a
 * filter that only searches the rows already downloaded quietly lies.
 *
 * `slaAttainment7d` is `null` for a programme with no traffic. It renders "No
 * data" and NO BAR. A zero would paint a red bar and assert something false
 * about a programme that has not started.
 */

const CHANNEL_ICON: Readonly<Record<ProgrammeChannel, IconName>> = {
  whatsapp: 'chat',
  voice: 'call',
  sms: 'sms',
  email: 'mail',
  ussd: 'dialpad',
};

export const STATUS_TONE: Readonly<Record<ProgrammeStatus, PillTone>> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};

/**
 * SLA colour bands. Amber below the usual 95 % contractual target, red below
 * 90 %. They are bands rather than a gradient because an operations manager
 * scanning eight rows needs "which of these is in trouble", not a hue.
 */
function slaTone(value: number): { bar: string; text: string } {
  // The bands the design draws: 96.2 green, 88.7-94.0 amber, 79.5 red.
  if (value >= 95) return { bar: 'bg-success', text: 'text-success-text' };
  if (value >= 85) return { bar: 'bg-warning', text: 'text-warning-text' };
  return { bar: 'bg-danger', text: 'text-danger-text' };
}

/**
 * The design's chips are All, Active, Paused and Draft. Archived is offered
 * only once something is archived: it is the only way back to an archived
 * programme from this list, and a chip reading "Archived 0" is noise.
 */
const STATUS_FILTERS: readonly (ProgrammeStatus | 'all')[] = ['all', 'active', 'paused', 'draft'];

export function ProgrammesScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ProgrammeStatus | 'all'>('all');

  const programmes = useResource(
    useCallback(
      (signal: AbortSignal) =>
        listProgrammes(
          { q: query, ...(status === 'all' ? {} : { status }) },
          signal,
        ),
      [query, status],
    ),
    [query, status],
  );

  const filtered = query.trim() !== '' || status !== 'all';

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales} linkedSettings={linkedSettings} bell={bell}
      activeSettingId="programmes"
    >
      <div data-screen="P02/B" className="flex flex-col gap-6">
        <PageHeader
          eyebrow={t.t('admin.prog.eyebrow')}
          title={t.t('admin.prog.title')}
          intro={t.t('admin.prog.intro')}
          actions={
            <AdminButton variant="primary" icon="add" notReady>
              {t.t('admin.prog.new')}
            </AdminButton>
          }
        />

        <Panel t={t} resource={programmes} skeletonRows={6}>
          {(data) =>
            data.items.length === 0 && !filtered ? (
              <EmptyState t={t} />
            ) : (
              <div className="flex flex-col gap-6">
                <div className="flex flex-wrap items-center gap-3">
                  <SearchField
                    id="programme-search"
                    label={t.t('admin.prog.search')}
                    value={query}
                    data-testid="programme-search"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t.t('admin.prog.search')}
                    className="w-full sm:w-80"
                  />
                  <div
                    role="group"
                    aria-label={t.t('admin.prog.filter.label')}
                    className="flex flex-wrap gap-1.5"
                  >
                    {[
                      ...STATUS_FILTERS,
                      ...((data.statusCounts.archived ?? 0) > 0 || status === 'archived'
                        ? (['archived'] as const)
                        : []),
                    ].map((value) => {
                      const selected = status === value;
                      const count =
                        value === 'all'
                          ? (data.page.totalCount ?? data.items.length)
                          : (data.statusCounts[value] ?? 0);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected}
                          data-testid={`status-${value}`}
                          onClick={() => setStatus(value)}
                          className={chipClass(selected)}
                        >
                          {t.t(`admin.prog.status.${value}` as MessageId)}
                          <ChipCount>{formatCount(locale, count)}</ChipCount>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {data.items.length === 0 ? (
                  <div
                    data-testid="programmes-no-results"
                    className={`${CARD} flex flex-col items-center gap-2.5 px-6 py-16 text-center`}
                  >
                    <span className="flex size-16 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                      <Icon name="search_off" size={32} />
                    </span>
                    <b className="text-h5 font-bold">{t.t('admin.prog.noResults.title')}</b>
                    <p className="m-0 text-body-sm text-text-2">{t.t('admin.prog.noResults.body')}</p>
                    <AdminButton
                      data-testid="clear-filters"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                      }}
                      className="mt-1.5"
                    >
                      {t.t('admin.prog.noResults.clear')}
                    </AdminButton>
                  </div>
                ) : (
                  <div className={`${CARD} overflow-hidden`}>
                    <div className="relative overflow-x-auto">
                      <table className="w-full min-w-max border-collapse text-body-sm">
                        <caption className="sr-only">{t.t('admin.prog.title')}</caption>
                        <thead className={TABLE_HEAD}>
                          <tr className="border-b border-border">
                            <th scope="col" className="ps-5 pe-2 text-start font-bold">
                              {t.t('admin.prog.col.programme')}
                            </th>
                            <th scope="col" className="w-28 px-2 text-start font-bold">
                              {t.t('admin.prog.col.channels')}
                            </th>
                            <th scope="col" className="w-24 px-2 text-start font-bold">
                              {t.t('admin.prog.col.agents')}
                            </th>
                            <th scope="col" className="w-40 px-2 text-start font-bold">
                              {t.t('admin.prog.col.sla')}
                            </th>
                            <th scope="col" className="w-24 px-2 text-start font-bold">
                              {t.t('admin.prog.col.retention')}
                            </th>
                            <th scope="col" className="w-24 px-2 text-start font-bold">
                              {t.t('admin.prog.col.status')}
                            </th>
                            <th scope="col" className="w-12">
                              <span className="sr-only">{t.t('admin.prog.col.open')}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.items.map((programme) => (
                            <ProgrammeRow
                              key={programme.id}
                              programme={programme}
                              locale={locale}
                              t={t}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )
          }
        </Panel>
      </div>
    </AdminShell>
  );
}

function ProgrammeRow({
  programme,
  locale,
  t,
}: {
  programme: Programme;
  locale: string;
  t: Translator;
}) {
  const router = useRouter();
  const sla = programme.slaAttainment7d ?? null;
  const tone = sla === null ? null : slaTone(sla);
  const href = `/admin/programmes/${encodeURIComponent(programme.id)}`;
  const country = formatCountry(locale, programme.countryCode);
  const subline = [programme.clientName ?? null, country]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');

  return (
    <tr
      data-testid="programme-row"
      onClick={(event) => {
        // The whole row opens the programme, as the design's rows do; the
        // name stays the one real link, for keyboards and new tabs.
        if ((event.target as HTMLElement).closest('a') === null) router.push(href);
      }}
      className="cursor-pointer border-b border-border last:border-b-0 is-hover:bg-surface-sunken"
    >
      <th scope="row" className="py-2.5 pe-2 ps-5 text-start font-normal">
        <Link
          href={href}
          className="flex min-w-0 flex-col gap-0.5 rounded-sm outline-none is-focus-visible:ring-focus"
        >
          <b className="text-body-sm font-bold text-text">{programme.name}</b>
          {subline === '' ? null : <span className="text-meta text-text-muted">{subline}</span>}
        </Link>
      </th>
      <td className="px-2">
        <span className="flex gap-1">
          {(programme.channels ?? []).map((channel) => (
            <span
              key={channel}
              title={t.t(`admin.channel.${channel}` as MessageId)}
              className="flex size-7 items-center justify-center rounded-6 bg-surface-sunken text-text-2"
            >
              <Icon name={CHANNEL_ICON[channel]} size={18} />
              <span className="sr-only">{t.t(`admin.channel.${channel}` as MessageId)}</span>
            </span>
          ))}
        </span>
      </td>
      <td className="px-2">
        {programme.agentCount === null || programme.agentCount === undefined
          ? t.t('admin.prog.noneYet')
          : formatCount(locale, programme.agentCount)}
      </td>
      <td className="px-2" data-testid="sla-cell">
        <span className="flex items-center gap-2">
          <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-surface-sunken">
            {sla === null || tone === null ? null : (
              <span
                className={`absolute inset-y-0 start-0 ${tone.bar}`}
                style={{ inlineSize: `${sla}%` }}
              />
            )}
          </span>
          {sla === null || tone === null ? (
            <span className="font-semibold text-text">{t.t('admin.prog.noData')}</span>
          ) : (
            <span className={`font-semibold ${tone.text}`}>{formatPercent(locale, sla)}</span>
          )}
        </span>
      </td>
      <td className="px-2 text-text-2">
        {programme.retentionSummary ?? t.t('admin.prog.notSet')}
      </td>
      <td className="px-2">
        <Pill tone={STATUS_TONE[programme.status]}>
          {t.t(`admin.prog.status.${programme.status}` as MessageId)}
        </Pill>
      </td>
      <td className="pe-3 text-end">
        <Icon name="chevron_right" size={20} className="text-text-muted rtl:-scale-x-100" />
      </td>
    </tr>
  );
}

function EmptyState({ t }: { t: Translator }) {
  return (
    <div
      data-screen="P02/B1"
      data-testid="programmes-empty"
      className={`${CARD} flex flex-col items-center gap-3.5 px-6 py-16 text-center`}
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
        <Icon name="support_agent" size={32} />
      </span>
      <h2 className="m-0 text-h4 font-bold">{t.t('admin.prog.empty.title')}</h2>
      <p className="m-0 max-w-lg text-pretty text-label font-normal text-text-2">
        {t.t('admin.prog.empty.body')}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <AdminButton variant="primary" icon="add" notReady>
          {t.t('admin.prog.new')}
        </AdminButton>
        <AdminButton icon="upload_file" notReady>
          {t.t('admin.prog.empty.import')}
        </AdminButton>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <span className="text-meta text-text-muted">{t.t('admin.prog.empty.templates')}</span>
        {(
          [
            'admin.prog.template.collections',
            'admin.prog.template.support',
            'admin.prog.template.sales',
          ] as const
        ).map((id) => (
          <span
            key={id}
            className="inline-flex h-7 items-center rounded-full bg-surface-sunken px-2.5 text-meta font-semibold"
          >
            {t.t(id)}
          </span>
        ))}
      </div>
    </div>
  );
}
