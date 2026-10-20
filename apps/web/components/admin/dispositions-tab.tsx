'use client';

import { useCallback, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import { Pill, type PillTone } from '@kasuwa/ui/components';
import { AdminButton, CARD, Notice, ROW_ICON_BUTTON, TABLE_HEAD } from './admin-ui';
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

const CATEGORY_TONE: Readonly<Record<DispositionCategory, PillTone>> = {
  promise_to_pay: 'primary',
  resolved: 'success',
  callback: 'info',
  escalated: 'warning',
  not_reached: 'neutral',
};

/** "Required" with a tick in success, "Optional" with a dash in muted, as the export draws them. */
function Requirement({ required, label }: { required: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1 text-meta ${required ? 'text-success-text' : 'text-text-muted'}`}>
      <Icon name={required ? 'check' : 'remove'} size={18} />
      {label}
    </span>
  );
}

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
    <div data-screen="P02/B5" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        <p className="m-0 min-w-0 flex-1 basis-80 text-label font-normal text-text-2">{t.t('admin.disp.intro')}</p>
        <AdminButton variant="primary" icon="add" notReady>
          {t.t('admin.disp.add')}
        </AdminButton>
      </div>

      <Panel t={t} resource={dispositions} skeletonRows={8}>
        {(data) => (
          <div className={`${CARD} overflow-hidden`}>
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.prog.tab.dispositions')}</caption>
                <thead className={TABLE_HEAD}>
                  <tr className="border-b border-border">
                    <th scope="col" className="w-24 ps-5 pe-2 text-start font-bold">
                      {t.t('admin.disp.col.code')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.disp.col.label')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.disp.col.category')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.disp.col.note')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.disp.col.followUp')}
                    </th>
                    <th scope="col" className="px-2 text-start font-bold">
                      {t.t('admin.disp.col.used', { days: data.usageWindowDays })}
                    </th>
                    <th scope="col" className="w-14">
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
                      className="border-b border-border last:border-b-0"
                    >
                      <td className="pe-2 ps-5 font-mono text-meta font-semibold">{disposition.code}</td>
                      <th scope="row" className="px-2 text-start font-semibold">
                        {disposition.label}
                        {disposition.active ? null : (
                          <Pill tone="neutral" className="ms-2">
                            {t.t('admin.disp.inactive')}
                          </Pill>
                        )}
                      </th>
                      <td className="px-2">
                        <Pill tone={CATEGORY_TONE[disposition.category]}>
                          {t.t(`admin.disp.cat.${disposition.category}` as MessageId)}
                        </Pill>
                      </td>
                      <td className="px-2">
                        <Requirement
                          required={disposition.noteRequired}
                          label={t.t(disposition.noteRequired ? 'admin.disp.required' : 'admin.disp.optional')}
                        />
                      </td>
                      <td className="px-2">
                        <Requirement
                          required={disposition.followUpRequired}
                          label={t.t(disposition.followUpRequired ? 'admin.disp.required' : 'admin.disp.optional')}
                        />
                      </td>
                      <td className="px-2 text-text-2">
                        {disposition.usageCount90d === null || disposition.usageCount90d === undefined
                          ? t.t('admin.prog.unknown')
                          : formatCount(locale, disposition.usageCount90d)}
                      </td>
                      <td className="py-1.5 pe-2">
                        <button
                          type="button"
                          aria-label={t.t('admin.disp.delete', { label: disposition.label })}
                          data-testid="delete-disposition"
                          onClick={() => {
                            setError(null);
                            setTarget(disposition);
                          }}
                          className={`${ROW_ICON_BUTTON} size-10 is-hover:bg-danger-soft is-hover:text-danger-text`}
                        >
                          <Icon name="delete" size={20} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      {toast === null ? null : (
        <Notice tone="success" testId="disposition-toast">
          {toast}
        </Notice>
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
              <AdminButton onClick={() => setTarget(null)} data-testid="delete-cancel">
                {t.t('admin.disp.delete.cancel')}
              </AdminButton>
              <AdminButton
                disabled={busy}
                onClick={() => void run('deactivate')}
                data-testid="deactivate-instead"
              >
                {t.t('admin.disp.delete.alt')}
              </AdminButton>
              <AdminButton
                variant="danger"
                disabled={busy}
                onClick={() => void run('delete')}
                data-testid="delete-confirm"
              >
                {t.t('admin.disp.delete.confirm')}
              </AdminButton>
            </>
          }
        >
          {/* Null usage means the aggregate is unavailable. The sentence is
              omitted rather than rendered as zero — see the note at the top. */}
          {target.usageCount90d === null || target.usageCount90d === undefined ? null : (
            <p data-testid="delete-usage" className="m-0 text-body-relaxed text-text-2">
              {t.t('admin.disp.delete.usage', {
                count: target.usageCount90d,
                days: dispositions.data?.usageWindowDays ?? 90,
              })}
            </p>
          )}
          <p className="m-0 flex gap-2.5 rounded-10 bg-info-soft px-3.5 py-3 text-meta text-info-text">
            <Icon name="lightbulb" size={18} className="shrink-0" />
            {t.t('admin.disp.delete.hint')}
          </p>
          {error === null ? null : (
            <p
              role="alert"
              data-testid="delete-error"
              data-error-code={error.code}
              className="m-0 rounded-10 bg-danger-soft px-3.5 py-3 text-meta text-danger-text"
            >
              {t.t(errorMessageId(error))}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
