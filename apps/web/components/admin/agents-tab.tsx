'use client';

import { useCallback, useState } from 'react';
import { localeLabel, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { Pill, type PillTone } from '@kasuwa/ui/components';
import { AdminButton, CARD, SearchField, TABLE_HEAD } from './admin-ui';
import {
  getSkillCover,
  listProgrammeAgents,
  type Presence,
  type SkillCover,
} from '../../lib/admin-api';
import { formatCount, formatDate } from '../../lib/admin-format';
import { SampleData } from './sample-data';

/**
 * `P02/B3` — agents and skills.
 *
 * ---------------------------------------------------------------------------
 * TWO NULLS ON THIS TAB, AND NEITHER OF THEM IS A ZERO.
 *
 * `presence` is null when the TELEPHONY adapter cannot answer (ADR-0003) and
 * `needed` is null when the WFM forecast cannot (same ADR, both blocked
 * decisions). Null means "we do not know".
 *
 *   - A null presence renders "Not known", never "Offline". A supervisor told
 *     an agent is offline when the truth is that we lost the feed will move
 *     that agent's calls somewhere else, on a fiction.
 *   - A null `needed` renders the rostered count with NO BAR and no colour. A
 *     cover bar that turns amber because the forecast was missing is worse
 *     than no bar: it invents a staffing problem.
 * ---------------------------------------------------------------------------
 *
 * The table carries a name, a team, skills and languages, and nothing else. No
 * email address and no phone number — the contract does not send them and this
 * screen must not start asking. An admin who needs to contact an agent goes to
 * the user record, which has its own permission and its own audit trail.
 */

const PRESENCE_TONE: Readonly<Record<Presence, PillTone>> = {
  available: 'success',
  on_call: 'primary',
  on_break: 'warning',
  offline: 'neutral',
};

export function AgentsTab({
  t,
  locale,
  programmeId,
  live,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
  /**
   * The live-API flag (T-0035), evaluated on the server. The agent list is
   * the real API either way; skill cover has no endpoint yet, so on the live
   * console it is labelled sample data from `lib/admin-sample.ts`.
   */
  live: boolean;
}) {
  const [query, setQuery] = useState('');

  const agents = useResource(
    useCallback(
      (signal: AbortSignal) => listProgrammeAgents(programmeId, query, signal),
      [programmeId, query],
    ),
    [programmeId, query],
  );
  const cover = useResource(
    useCallback(
      (signal: AbortSignal) =>
        live
          ? // Loaded only on the live console (see programme-screen.tsx).
            import('../../lib/admin-sample').then((sample) =>
              sample.sampleResult(sample.sampleSkillCover((id) => t.t(id), new Date())),
            )
          : getSkillCover(programmeId, signal),
      // `t` is rebuilt every render; the locale is what changes its output.
      [programmeId, live, locale],
    ),
    [programmeId, live, locale],
  );

  const coverPanel = (
    <Panel t={t} resource={cover} skeletonRows={4}>
      {(data) => <CoverList t={t} locale={locale} data={data} />}
    </Panel>
  );

  return (
    <div data-screen="P02/B3" className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className={`${CARD} min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <SearchField
            id="agent-search"
            label={t.t('admin.agents.search')}
            value={query}
            data-testid="agent-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.t('admin.agents.search')}
            className="w-full sm:w-64"
          />
          <span className="flex-1 text-meta text-text-muted">
            {agents.data === null
              ? null
              : t.t('admin.agents.showing', {
                  shown: formatCount(locale, agents.data.items.length),
                  total: formatCount(locale, agents.data.page.totalCount ?? agents.data.items.length),
                })}
          </span>
          <AdminButton variant="primary" icon="person_add" notReady>
            {t.t('admin.agents.add')}
          </AdminButton>
        </div>

        <div className="relative overflow-x-auto [&>[role=status]]:m-4 [&>[role=alert]]:m-4">
          <Panel t={t} resource={agents} skeletonRows={6}>
            {(data) => (
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.prog.tab.agents')}</caption>
                <thead className={TABLE_HEAD}>
                  <tr className="border-b border-border">
                    <th scope="col" className="ps-4 pe-2 text-start font-bold">
                      {t.t('admin.agents.col.agent')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.agents.col.team')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.agents.col.skills')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.agents.col.languages')}
                    </th>
                    <th scope="col" className="pe-4 ps-2 text-start font-bold">
                      {t.t('admin.agents.col.now')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((agent) => (
                    <tr key={agent.userId} className="h-14 border-b border-border last:border-b-0">
                      <th scope="row" className="pe-2 ps-4 text-start font-normal">
                        <span className="flex items-center gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-text">
                            {agent.initials ?? ''}
                          </span>
                          <b className="font-semibold">{agent.displayName}</b>
                        </span>
                      </th>
                      <td className="px-2 text-text-2">{agent.teamName ?? ''}</td>
                      <td className="px-2 py-1.5">
                        <span className="flex flex-wrap gap-1">
                          {(agent.skills ?? []).map((skill) => (
                            <span
                              key={skill}
                              className="inline-flex h-6 items-center rounded-6 border border-border px-2 text-caption font-semibold"
                            >
                              {skill}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="px-2 text-meta text-text-2">
                        {/* Endonyms, from `@kasuwa/i18n`. The contract sends
                            BCP 47 tags precisely so the display name is not the
                            server's decision, and a language menu written in
                            English is useless to the person who reads it. */}
                        {(agent.languages ?? []).map((tag) => localeLabel(tag)).join(', ')}
                      </td>
                      <td className="pe-4 ps-2" data-testid="agent-presence">
                        {agent.presence === null ? (
                          <Pill
                            tone="unknown"
                            title={t.t('admin.agents.presence.unknown.why')}
                            data-presence="unknown"
                          >
                            {t.t('admin.agents.presence.unknown')}
                          </Pill>
                        ) : (
                          <Pill tone={PRESENCE_TONE[agent.presence]} data-presence={agent.presence}>
                            {t.t(`admin.agents.presence.${agent.presence}` as MessageId)}
                          </Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>

      <section className={`${CARD} flex flex-col gap-3.5 p-4.5`}>
        {live ? (
          <SampleData t={t} testId="cover-sample">
            {coverPanel}
          </SampleData>
        ) : (
          coverPanel
        )}
        <AdminButton notReady className="w-full">
          {t.t('admin.agents.manageSkills')}
        </AdminButton>
      </section>
    </div>
  );
}

function CoverList({ t, locale, data }: { t: Translator; locale: string; data: SkillCover }) {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-label font-bold">
          {t.t('admin.agents.cover.title', {
            shift: t.t(`admin.agents.shift.${data.shift}` as MessageId),
          })}
        </h2>
        <span className="text-meta text-text-muted">
          {t.t('admin.agents.cover.subtitle', {
            // The programme's own zone, sent explicitly by the
            // contract. "Monday" is not one day across WAT, EAT and
            // SAST, and the browser's zone is not this roster's.
            date: formatDate(locale, `${data.shiftDate}T00:00:00.000Z`, data.timeZone),
            zone: data.timeZone,
          })}
        </span>
      </div>

      {data.items.map((item) => {
        const needed = item.needed ?? null;
        const ratio = needed === null || needed === 0 ? null : item.rostered / needed;
        return (
          <div key={item.skillId} className="flex flex-col gap-1.5" data-skill-id={item.skillId}>
            <div className="flex justify-between gap-2 text-meta">
              <b className="font-semibold">{item.label}</b>
              {needed === null ? (
                <span data-testid="cover-unknown" className="font-semibold text-text-muted">
                  {t.t('admin.agents.cover.rostered', {
                    rostered: formatCount(locale, item.rostered),
                  })}
                </span>
              ) : (
                <span
                  className={
                    ratio !== null && ratio < 1
                      ? 'font-semibold text-warning-text'
                      : 'font-semibold text-text-2'
                  }
                >
                  {t.t('admin.agents.cover.value', {
                    rostered: formatCount(locale, item.rostered),
                    needed: formatCount(locale, needed),
                  })}
                </span>
              )}
            </div>
            {ratio === null ? (
              <span className="text-caption text-text-muted">
                {t.t('admin.agents.cover.noForecast')}
              </span>
            ) : (
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className={`block h-full ${ratio < 1 ? 'bg-warning' : 'bg-success'}`}
                  style={{ inlineSize: `${Math.min(100, ratio * 100)}%` }}
                />
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
