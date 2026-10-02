'use client';

import { useCallback, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import {
  deactivateDisposition,
  deleteDisposition,
  listDispositions,
  type Disposition,
  type DispositionCategory,
  type ScreenError,
} from '../../lib/admin-api';
import { formatCount } from '../../lib/admin-format';

/**
 * `P02/B5` — dispositions, and the delete dialog that is most of this tab.
 *
 * ---------------------------------------------------------------------------
 * THE DIALOG SHOWS THE USAGE AND OFFERS THE SOFTER OPTION FIRST.
 *
 * "Agents picked this 3,214 times in the last 90 days" is the whole point of
 * the dialog: an admin tidying up a list cannot otherwise tell a dead code from
 * the one every collections agent uses. And "Deactivate instead" sits beside
 * Delete because it is almost always the right answer — agents stop seeing it,
 * historical reporting stays clean, and it can be turned back on.
 *
 * `usageCount90d` is NULLABLE and null is not zero. When the aggregate is
 * unavailable the sentence is OMITTED, not rendered as "0 times". Telling an
 * admin that a busy code is unused is the one wrong answer that actually gets
 * the code deleted.
 * ---------------------------------------------------------------------------
 */

const CATEGORY_TONE: Readonly<Record<DispositionCategory, string>> = {
  promise_to_pay: 'bg-primary-soft text-primary-text',
  resolved: 'bg-success-soft text-success-text',
  callback: 'bg-info-soft text-info-text',
  escalated: 'bg-warning-soft text-warning-text',
  not_reached: 'bg-surface-sunken text-text-2',
};

export function DispositionsTab({
  t,
  locale,
  programmeId,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
}) {
  const dispositions = useResource(
    useCallback((signal: AbortSignal) => listDispositions(programmeId, signal), [programmeId]),
    [programmeId],
  );

  const [target, setTarget] = useState<Disposition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScreenError | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const run = async (action: 'delete' | 'deactivate') => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    const result =
      action === 'delete'
        ? await deleteDisposition(programmeId, target.id)
        : await deactivateDisposition(programmeId, target.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setToast(
      t.t(action === 'delete' ? 'admin.disp.deleted' : 'admin.disp.deactivated', {
        label: target.label,
      }),
    );
    setTarget(null);
    dispositions.reload();
  };

  return (
    <div data-screen="P02/B5" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-body-sm text-text-2">{t.t('admin.disp.intro')}</p>
        <span className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`} aria-disabled>
          <Icon name="add" size="sm" />
          {t.t('admin.disp.add')}
        </span>
      </div>

      <Panel t={t} resource={dispositions} skeletonRows={8}>
        {(data) => (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-max border-collapse text-body-sm">
              <caption className="sr-only">{t.t('admin.prog.tab.dispositions')}</caption>
              <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                <tr>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.code')}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.label')}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.category')}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.note')}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.followUp')}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    {t.t('admin.disp.col.used', { days: data.usageWindowDays })}
                  </th>
                  <th scope="col" className="p-3 text-start font-bold">
                    <span className="sr-only">{t.t('admin.disp.delete', { label: '' })}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((disposition) => (
                  <tr
                    key={disposition.id}
                    data-testid="disposition-row"
                    data-disposition-code={disposition.code}
                    className="border-t border-border"
                  >
                    <td className="p-3 font-mono text-mono">{disposition.code}</td>
                    <th scope="row" className="p-3 text-start font-semibold">
                      {disposition.label}
                      {disposition.active ? null : (
                        <span className="ms-2 rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-muted">
                          {t.t('admin.disp.inactive')}
                        </span>
                      )}
                    </th>
                    <td className="p-3">
                      <span
                        className={`inline-flex rounded-full px-2 text-caption font-bold ${CATEGORY_TONE[disposition.category]}`}
                      >
                        {t.t(`admin.disp.cat.${disposition.category}` as MessageId)}
                      </span>
                    </td>
                    <td className="p-3 text-text-2">
                      {t.t(disposition.noteRequired ? 'admin.disp.required' : 'admin.disp.optional')}
                    </td>
                    <td className="p-3 text-text-2">
                      {t.t(
                        disposition.followUpRequired ? 'admin.disp.required' : 'admin.disp.optional',
                      )}
                    </td>
                    <td className="p-3 text-text-2">
                      {disposition.usageCount90d === null || disposition.usageCount90d === undefined
                        ? t.t('admin.prog.unknown')
                        : formatCount(locale, disposition.usageCount90d)}
                    </td>
                    <td className="p-3">
                      <button
                        type="button"
                        aria-label={t.t('admin.disp.delete', { label: disposition.label })}
                        data-testid="delete-disposition"
                        onClick={() => {
                          setError(null);
                          setTarget(disposition);
                        }}
                        className="flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-muted hover:bg-danger-soft hover:text-danger-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                      >
                        <Icon name="delete" size="sm" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {toast === null ? null : (
        <p
          role="status"
          data-testid="disposition-toast"
          className="rounded-md bg-success-soft p-3 text-body-sm text-success-text"
        >
          {toast}
        </p>
      )}

      {target === null ? null : (
        <Dialog
          title={t.t('admin.disp.delete.title', { label: target.label })}
          body={t.t('admin.disp.delete.body')}
          icon="delete"
          tone="danger"
          testId="delete-disposition-dialog"
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setTarget(null)}
                className={SECONDARY_BUTTON}
                data-testid="delete-cancel"
              >
                {t.t('admin.disp.delete.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('deactivate')}
                className={SECONDARY_BUTTON}
                data-testid="deactivate-instead"
              >
                {t.t('admin.disp.delete.alt')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('delete')}
                data-testid="delete-confirm"
                className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary hover:bg-danger-hover disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t.t('admin.disp.delete.confirm')}
              </button>
            </>
          }
        >
          {/* Null usage means the aggregate is unavailable. The sentence is
              omitted rather than rendered as zero — see the note at the top. */}
          {target.usageCount90d === null || target.usageCount90d === undefined ? null : (
            <p data-testid="delete-usage" className="text-body-sm">
              {t.t('admin.disp.delete.usage', {
                count: target.usageCount90d,
                days: dispositions.data?.usageWindowDays ?? 90,
              })}
            </p>
          )}
          <p className="flex gap-2 rounded-md bg-info-soft p-3 text-body-sm text-info-text">
            <Icon name="lightbulb" size="sm" />
            {t.t('admin.disp.delete.hint')}
          </p>
          {error === null ? null : (
            <p
              role="alert"
              data-testid="delete-error"
              data-error-code={error.code}
              className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
            >
              {t.t(errorMessageId(error))}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
