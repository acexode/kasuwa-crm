'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel } from './panel';
import { useResource } from './use-resource';
import type { LanguageOption } from '../auth/language-menu';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import {
  listProgrammes,
  type Programme,
  type ProgrammeChannel,
  type ProgrammeStatus,
} from '../../lib/admin-api';
import { formatCount, formatPercent } from '../../lib/admin-format';

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

const STATUS_TONE: Readonly<Record<ProgrammeStatus, string>> = {
  active: 'bg-success-soft text-success-text',
  paused: 'bg-warning-soft text-warning-text',
  draft: 'bg-surface-sunken text-text-2',
  archived: 'bg-surface-sunken text-text-muted',
};

/**
 * SLA colour bands. Amber below the usual 95 % contractual target, red below
 * 90 %. They are bands rather than a gradient because an operations manager
 * scanning eight rows needs "which of these is in trouble", not a hue.
 */
function slaTone(value: number): { bar: string; text: string } {
  if (value >= 95) return { bar: 'bg-success', text: 'text-success-text' };
  if (value >= 90) return { bar: 'bg-warning', text: 'text-warning-text' };
  return { bar: 'bg-danger', text: 'text-danger-text' };
}

const STATUS_FILTERS: readonly (ProgrammeStatus | 'all')[] = [
  'all',
  'active',
  'paused',
  'draft',
  'archived',
];

export function ProgrammesScreen({
  locale,
  messages,
  locales,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
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
      locales={locales}
      activeSettingId="programmes"
    >
      <div data-screen="P02/B" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-h6 text-text-muted">{t.t('admin.prog.eyebrow')}</span>
            <h1 className="text-h2">{t.t('admin.prog.title')}</h1>
            <p className="max-w-2xl text-body-md text-text-2">{t.t('admin.prog.intro')}</p>
          </div>
          <span className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
            <Icon name="add" size="sm" />
            {t.t('admin.prog.new')}
          </span>
        </div>

        <Panel t={t} resource={programmes} skeletonRows={6}>
          {(data) =>
            data.items.length === 0 && !filtered ? (
              <EmptyState t={t} />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="sr-only" htmlFor="programme-search">
                    {t.t('admin.prog.search')}
                  </label>
                  <input
                    id="programme-search"
                    type="search"
                    value={query}
                    data-testid="programme-search"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t.t('admin.prog.search')}
                    className="min-h-touch w-full rounded-md border border-border-strong bg-surface px-3 text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:w-80"
                  />
                  <div
                    role="group"
                    aria-label={t.t('admin.prog.filter.label')}
                    className="flex flex-wrap gap-2"
                  >
                    {STATUS_FILTERS.map((value) => {
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
                          className={`flex min-h-touch items-center gap-2 rounded-full border px-4 text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                            selected
                              ? 'border-primary bg-primary-soft text-primary-text'
                              : 'border-border bg-surface text-text hover:bg-surface-sunken'
                          }`}
                        >
                          {t.t(`admin.prog.status.${value}` as MessageId)}
                          <span className="font-normal">{formatCount(locale, count)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {data.items.length === 0 ? (
                  <div
                    data-testid="programmes-no-results"
                    className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-10 text-center"
                  >
                    <Icon name="search_off" size="xl" className="text-text-muted" />
                    <b className="text-body-md">{t.t('admin.prog.noResults.title')}</b>
                    <p className="text-body-sm text-text-2">{t.t('admin.prog.noResults.body')}</p>
                    <button
                      type="button"
                      data-testid="clear-filters"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                      }}
                      className={SECONDARY_BUTTON}
                    >
                      {t.t('admin.prog.noResults.clear')}
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                    <table className="w-full min-w-max border-collapse text-body-sm">
                      <caption className="sr-only">{t.t('admin.prog.title')}</caption>
                      <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                        <tr>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.programme')}
                          </th>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.channels')}
                          </th>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.agents')}
                          </th>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.sla')}
                          </th>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.retention')}
                          </th>
                          <th scope="col" className="p-3 text-start font-bold">
                            {t.t('admin.prog.col.status')}
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
  const sla = programme.slaAttainment7d ?? null;
  const tone = sla === null ? null : slaTone(sla);

  return (
    <tr data-testid="programme-row" className="border-t border-border hover:bg-surface-sunken">
      <th scope="row" className="p-3 text-start font-normal">
        <Link
          href={`/admin/programmes/${encodeURIComponent(programme.id)}`}
          className="flex flex-col rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <b className="text-body-sm">{programme.name}</b>
          <span className="text-body-sm text-text-muted">{programme.clientName ?? ''}</span>
        </Link>
      </th>
      <td className="p-3">
        <span className="flex gap-1">
          {(programme.channels ?? []).map((channel) => (
            <span
              key={channel}
              title={t.t(`admin.channel.${channel}` as MessageId)}
              className="flex h-7 w-7 items-center justify-center rounded-sm bg-surface-sunken text-text-2"
            >
              <Icon name={CHANNEL_ICON[channel]} size="sm" />
              <span className="sr-only">{t.t(`admin.channel.${channel}` as MessageId)}</span>
            </span>
          ))}
        </span>
      </td>
      <td className="p-3">
        {programme.agentCount === null || programme.agentCount === undefined
          ? t.t('admin.prog.noData')
          : formatCount(locale, programme.agentCount)}
      </td>
      <td className="p-3" data-testid="sla-cell">
        {sla === null || tone === null ? (
          <span className="text-text-muted">{t.t('admin.prog.noData')}</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="h-2 w-14 overflow-hidden rounded-full bg-surface-sunken">
              <span className={`block h-full ${tone.bar}`} style={{ inlineSize: `${sla}%` }} />
            </span>
            <span className={`font-semibold ${tone.text}`}>{formatPercent(locale, sla)}</span>
          </span>
        )}
      </td>
      <td className="p-3 text-text-2">
        {programme.retentionSummary ?? t.t('admin.prog.notSet')}
      </td>
      <td className="p-3">
        <span
          className={`inline-flex rounded-full px-2 text-caption font-bold ${STATUS_TONE[programme.status]}`}
        >
          {t.t(`admin.prog.status.${programme.status}` as MessageId)}
        </span>
      </td>
    </tr>
  );
}

function EmptyState({ t }: { t: Translator }) {
  return (
    <div
      data-screen="P02/B1"
      data-testid="programmes-empty"
      className="flex flex-col items-center gap-4 rounded-lg border border-border bg-surface p-12 text-center"
    >
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
        <Icon name="support_agent" size="xl" />
      </span>
      <h2 className="text-h3">{t.t('admin.prog.empty.title')}</h2>
      <p className="max-w-xl text-body-md text-text-2">{t.t('admin.prog.empty.body')}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <span className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
          <Icon name="add" size="sm" />
          {t.t('admin.prog.new')}
        </span>
        <span className={`${SECONDARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
          <Icon name="upload_file" size="sm" />
          {t.t('admin.prog.empty.import')}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-body-sm text-text-muted">{t.t('admin.prog.empty.templates')}</span>
        {(
          [
            'admin.prog.template.collections',
            'admin.prog.template.support',
            'admin.prog.template.sales',
          ] as const
        ).map((id) => (
          <span
            key={id}
            className="rounded-full bg-surface-sunken px-3 py-1 text-body-sm font-semibold"
          >
            {t.t(id)}
          </span>
        ))}
      </div>
    </div>
  );
}
