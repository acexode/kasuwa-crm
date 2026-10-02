'use client';

import { useCallback } from 'react';
import { localeLabel, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { PRIMARY_BUTTON } from '../auth/button-classes';
import { listScripts, type ScriptStatus } from '../../lib/admin-api';
import { formatDate } from '../../lib/admin-format';

/**
 * `P02/B6` — the scripts a programme's agents read from.
 *
 * READ-ONLY HERE, ON PURPOSE. The script *builder* is M10 and a screen of its
 * own; this is the index the programme tab shows, and "New script" is a
 * visibly disabled control rather than a live button that would answer 501.
 *
 * ---------------------------------------------------------------------------
 * THE PROVIDER IS NOT NAMED IN CODE.
 *
 * The design's status reads "Rejected by Meta". The contract's enum is
 * `rejected_by_provider`, because no module outside the channel adapters may
 * name an external system (CLAUDE.md rule 8). `providerName` is a display
 * string the adapter supplies; this screen renders it and NEVER branches on it.
 * The status chip's colour comes from the enum, the words come from the server.
 *
 * `providerName` being null is normal — a draft has not been to a provider —
 * and the status then reads on its own.
 * ---------------------------------------------------------------------------
 *
 * Languages arrive as BCP 47 tags and are rendered through `localeLabel`'s
 * endonyms via the shared helper, so a Yorùbá script says "Yorùbá" and not
 * "yo".
 */

const STATUS_TONE: Readonly<Record<ScriptStatus, string>> = {
  published: 'bg-success-soft text-success-text',
  rejected_by_provider: 'bg-danger-soft text-danger-text',
  draft: 'bg-surface-sunken text-text-2',
  in_review: 'bg-info-soft text-info-text',
};

export function ScriptsTab({
  t,
  locale,
  programmeId,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
}) {
  const scripts = useResource(
    useCallback((signal: AbortSignal) => listScripts(programmeId, signal), [programmeId]),
    [programmeId],
  );

  return (
    <div data-screen="P02/B6" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-body-sm text-text-2">{t.t('admin.scripts.intro')}</p>
        {/* The script builder is M10. A control that looks live and answers
            501 is worse than one that is visibly not ready yet. */}
        <span
          className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`}
          aria-disabled
          data-testid="add-script"
        >
          <Icon name="add" size="sm" />
          {t.t('admin.scripts.add')}
        </span>
      </div>

      <Panel t={t} resource={scripts} skeletonRows={6}>
        {(data) =>
          data.items.length === 0 ? (
            <div
              data-testid="scripts-empty"
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-12 text-center"
            >
              <Icon name="description" size="xl" className="text-text-muted" />
              <h2 className="text-h5">{t.t('admin.scripts.empty.title')}</h2>
              <p className="max-w-prose text-body-sm text-text-2">
                {t.t('admin.scripts.empty.body')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-surface">
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.prog.tab.scripts')}</caption>
                <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                  <tr>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.name')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.channel')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.languages')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.version')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.status')}
                    </th>
                    <th scope="col" className="p-3 text-start font-bold">
                      {t.t('admin.scripts.col.updated')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((script) => (
                    <tr
                      key={script.id}
                      data-testid="script-row"
                      data-script-status={script.status}
                      className="border-t border-border align-top"
                    >
                      <th scope="row" className="p-3 text-start font-semibold">
                        {script.name}
                      </th>
                      <td className="p-3 text-text-2">
                        {(script.channels ?? []).length === 0
                          ? t.t('admin.prog.unknown')
                          : (script.channels ?? [])
                              .map((channel) => t.t(`admin.channel.${channel}` as MessageId))
                              .join(' · ')}
                      </td>
                      <td className="p-3 text-text-2">
                        {(script.languages ?? []).length === 0
                          ? t.t('admin.prog.unknown')
                          : (script.languages ?? []).map(localeLabel).join(', ')}
                      </td>
                      <td className="p-3 font-mono text-mono">
                        {t.t('admin.scripts.version', { version: script.version })}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex rounded-full px-2 text-caption font-bold ${STATUS_TONE[script.status]}`}
                        >
                          {t.t(`admin.scripts.status.${script.status}` as MessageId)}
                        </span>
                        {/* The provider's own words, rendered and never parsed.
                            Null is normal: a draft has not been to one. */}
                        {script.providerName === null || script.providerName === undefined ? null : (
                          <span
                            data-testid="script-provider"
                            className="mt-1 block text-caption text-text-muted"
                          >
                            {script.providerName}
                          </span>
                        )}
                        {script.rejectionReason === null ||
                        script.rejectionReason === undefined ? null : (
                          <span
                            data-testid="script-rejection"
                            className="mt-1 block max-w-xs text-caption text-text-2"
                          >
                            {script.rejectionReason}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-text-muted">
                        {formatDate(locale, script.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Panel>
    </div>
  );
}
