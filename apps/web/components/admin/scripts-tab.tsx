'use client';

import { useCallback } from 'react';
import { localeLabel, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { Pill, type PillTone } from '@kasuwa/ui/components';
import { AdminButton, CARD, TABLE_HEAD } from './admin-ui';
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

const STATUS_TONE: Readonly<Record<ScriptStatus, PillTone>> = {
  published: 'success',
  rejected_by_provider: 'danger',
  draft: 'neutral',
  in_review: 'info',
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
      <div className="flex flex-wrap items-center gap-4">
        <p className="m-0 min-w-0 flex-1 basis-80 text-label font-normal text-text-2">{t.t('admin.scripts.intro')}</p>
        {/* The script builder is M10. A control that looks live and answers
            501 is worse than one that is visibly not ready yet. */}
        <AdminButton variant="primary" icon="add" notReady data-testid="add-script">
          {t.t('admin.scripts.add')}
        </AdminButton>
      </div>

      <Panel t={t} resource={scripts} skeletonRows={6}>
        {(data) =>
          data.items.length === 0 ? (
            <div
              data-testid="scripts-empty"
              className={`${CARD} flex flex-col items-center gap-2.5 px-6 py-16 text-center`}
            >
              <span className="flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
                <Icon name="description" size={32} />
              </span>
              <h2 className="m-0 text-h5 font-bold">{t.t('admin.scripts.empty.title')}</h2>
              <p className="m-0 max-w-md text-pretty text-body-sm text-text-2">
                {t.t('admin.scripts.empty.body')}
              </p>
            </div>
          ) : (
            <div
              /* A horizontally scrolling table is reachable with a mouse and,
                 without this, with nothing else. `tabIndex` puts it in the tab
                 order so the arrow keys can scroll it, and the region needs a
                 name once it is focusable. axe flags the omission as serious
                 and it is right to. */
              role="region"
              aria-label={t.t('admin.prog.tab.scripts')}
              tabIndex={0}
              className={`${CARD} relative overflow-x-auto outline-none is-focus-visible:ring-focus`}
            >
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.prog.tab.scripts')}</caption>
                <thead className={TABLE_HEAD}>
                  <tr className="border-b border-border">
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
                      {t.t('admin.scripts.col.name')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
                      {t.t('admin.scripts.col.channel')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
                      {t.t('admin.scripts.col.languages')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
                      {t.t('admin.scripts.col.version')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
                      {t.t('admin.scripts.col.status')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold first:ps-5 last:pe-5">
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
                      className="border-b border-border last:border-b-0"
                    >
                      <th scope="row" className="py-3.5 pe-2 ps-5 text-start font-semibold">
                        {script.name}
                      </th>
                      <td className="px-2 text-text-2">
                        {(script.channels ?? []).length === 0
                          ? t.t('admin.prog.unknown')
                          : (script.channels ?? [])
                              .map((channel) => t.t(`admin.channel.${channel}` as MessageId))
                              .join(' · ')}
                      </td>
                      <td className="px-2 text-text-2">
                        {(script.languages ?? []).length === 0
                          ? t.t('admin.prog.unknown')
                          : (script.languages ?? []).map(localeLabel).join(', ')}
                      </td>
                      <td className="px-2 font-mono text-meta">
                        {t.t('admin.scripts.version', { version: script.version })}
                      </td>
                      <td className="px-2 py-2">
                        <Pill tone={STATUS_TONE[script.status]}>
                          {t.t(`admin.scripts.status.${script.status}` as MessageId)}
                        </Pill>
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
                      <td className="pe-5 ps-2 text-meta text-text-2">
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
