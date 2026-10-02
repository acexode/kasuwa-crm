'use client';

import { useCallback, useState } from 'react';
import { localeLabel, type MessageId, type Translator } from '@kasuwa/i18n';
import { Icon } from '../icon';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { getSkillCover, listProgrammeAgents, type Presence } from '../../lib/admin-api';
import { formatCount, formatDate } from '../../lib/admin-format';

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

const PRESENCE_TONE: Readonly<Record<Presence, string>> = {
  available: 'bg-success-soft text-success-text',
  on_call: 'bg-primary-soft text-primary-text',
  on_break: 'bg-warning-soft text-warning-text',
  offline: 'bg-surface-sunken text-text-2',
};

export function AgentsTab({
  t,
  locale,
  programmeId,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
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
    useCallback((signal: AbortSignal) => getSkillCover(programmeId, signal), [programmeId]),
    [programmeId],
  );

  return (
    <div data-screen="P02/B3" className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <div className="flex flex-col gap-3 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <label className="sr-only" htmlFor="agent-search">
            {t.t('admin.agents.search')}
          </label>
          <input
            id="agent-search"
            type="search"
            value={query}
            data-testid="agent-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.t('admin.agents.search')}
            className="min-h-touch w-full rounded-md border border-border-strong bg-surface px-3 text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:w-64"
          />
          {agents.data === null ? (
            <span className="flex-1" />
          ) : (
            <span className="flex-1 text-body-sm text-text-muted">
              {t.t('admin.agents.showing', {
                shown: formatCount(locale, agents.data.items.length),
                total: formatCount(locale, agents.data.page.totalCount ?? agents.data.items.length),
              })}
            </span>
          )}
          <span className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
            <Icon name="person_add" size="sm" />
            {t.t('admin.agents.add')}
          </span>
        </div>

        <div className="overflow-x-auto p-1">
          <Panel t={t} resource={agents} skeletonRows={6}>
            {(data) => (
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.prog.tab.agents')}</caption>
                <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                  <tr>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.agents.col.agent')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.agents.col.team')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.agents.col.skills')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.agents.col.languages')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.agents.col.now')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((agent) => (
                    <tr key={agent.userId} className="border-t border-border">
                      <th scope="row" className="p-3 text-start">
                        <span className="flex items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-caption font-bold text-primary-text">
                            {agent.initials ?? ''}
                          </span>
                          <b className="font-semibold">{agent.displayName}</b>
                        </span>
                      </th>
                      <td className="p-3 text-text-2">{agent.teamName ?? ''}</td>
                      <td className="p-3">
                        <span className="flex flex-wrap gap-1">
                          {(agent.skills ?? []).map((skill) => (
                            <span
                              key={skill}
                              className="rounded-sm border border-border px-2 text-caption font-semibold"
                            >
                              {skill}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="p-3 text-body-sm text-text-2">
                        {/* Endonyms, from `@kasuwa/i18n`. The contract sends
                            BCP 47 tags precisely so the display name is not the
                            server's decision, and a language menu written in
                            English is useless to the person who reads it. */}
                        {(agent.languages ?? []).map((tag) => localeLabel(tag)).join(', ')}
                      </td>
                      <td className="p-3" data-testid="agent-presence">
                        {agent.presence === null ? (
                          <span
                            title={t.t('admin.agents.presence.unknown.why')}
                            data-presence="unknown"
                            className="inline-flex rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-muted"
                          >
                            {t.t('admin.agents.presence.unknown')}
                          </span>
                        ) : (
                          <span
                            data-presence={agent.presence}
                            className={`inline-flex rounded-full px-2 text-caption font-bold ${PRESENCE_TONE[agent.presence]}`}
                          >
                            {t.t(`admin.agents.presence.${agent.presence}` as MessageId)}
                          </span>
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

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <Panel t={t} resource={cover} skeletonRows={4}>
          {(data) => (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="text-h5">
                  {t.t('admin.agents.cover.title', {
                    shift: t.t(`admin.agents.shift.${data.shift}` as MessageId),
                  })}
                </h2>
                <span className="text-body-sm text-text-muted">
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
                  <div key={item.skillId} className="flex flex-col gap-2" data-skill-id={item.skillId}>
                    <div className="flex justify-between gap-2 text-body-sm">
                      <b className="font-semibold">{item.label}</b>
                      {needed === null ? (
                        <span data-testid="cover-unknown" className="text-text-muted">
                          {t.t('admin.agents.cover.rostered', {
                            rostered: formatCount(locale, item.rostered),
                          })}
                        </span>
                      ) : (
                        <span
                          className={
                            ratio !== null && ratio < 1
                              ? 'font-semibold text-warning-text'
                              : 'font-semibold text-success-text'
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
                      <span className="h-2 overflow-hidden rounded-full bg-surface-sunken">
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
          )}
        </Panel>
        <span className={`${SECONDARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
          {t.t('admin.agents.manageSkills')}
        </span>
      </section>
    </div>
  );
}
