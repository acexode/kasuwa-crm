'use client';

import { useCallback, useState } from 'react';
import type { IconName } from '@kasuwa/ui';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Dialog } from './dialog';
import { Skeleton, StillConnecting, ErrorPanel, errorMessageId } from './panel';
import { useResource } from './use-resource';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { archiveProgramme, getArchivePreview, type ScreenError } from '../../lib/admin-api';

/**
 * `P02/B9` — archive a programme.
 *
 * ---------------------------------------------------------------------------
 * THE IMPACT LIST IS READ WHEN THE DIALOG OPENS, NOT WHEN THE PAGE LOADED.
 *
 * `GET /archive-preview` is a separate call for one reason: the numbers have to
 * be true at the moment somebody reads them. "212 open interactions become
 * read-only" from a page that has been open since this morning is a number that
 * will be wrong by the time it is acted on, and it is the number the decision
 * turns on.
 *
 * A line is OMITTED when its value is null rather than rendered as zero.
 * `retentionSummary` is nullable, and "Recordings stay under the  rule" or
 * "…under the 0 rule" is worse than saying nothing: see the retention screen's
 * note on D-T4 for why that particular line is one we must not invent.
 * ---------------------------------------------------------------------------
 *
 * THE CONFIRMATION IS THE PROGRAMME'S NAME, NOT THE WORD "ARCHIVE".
 *
 * The design asks the admin to type "archive". The contract asks for the name,
 * and the contract is right: a constant word is the same keystrokes on every
 * programme and stops being a check after the second one. Typing the name is
 * the only version of this control that still means something on the tenth
 * programme, and the server validates the same string, so a client that asked
 * for a different word would simply fail.
 *
 * `POST /archive` is not built — the `programme` table has no status column —
 * and answers `501`. The dialog surfaces that as `admin.error.not_implemented`
 * and keeps the typed confirmation, rather than closing as though it worked.
 */

interface Impact {
  readonly icon: IconName;
  readonly id: MessageId;
  readonly value: number;
}

export function ArchiveDialog({
  t,
  programmeId,
  programmeName,
  onClose,
  onArchived,
}: {
  t: Translator;
  programmeId: string;
  programmeName: string;
  onClose: () => void;
  /** Re-read the programme, so the status chip says what just happened. */
  onArchived?: () => void;
}) {
  const preview = useResource(
    useCallback((signal: AbortSignal) => getArchivePreview(programmeId, signal), [programmeId]),
    [programmeId],
  );

  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScreenError | null>(null);

  // Case-insensitive and trimmed, because the check is "do you know which
  // programme you are archiving", not "can you reproduce capitalisation".
  const matches = confirmation.trim().toLocaleLowerCase() === programmeName.toLocaleLowerCase();

  const data = preview.data;
  const impacts: readonly Impact[] =
    data === null
      ? []
      : [
          {
            icon: 'group_off',
            id: 'admin.archive.impact.agents',
            value: data.agentsLosingAccess,
          },
          {
            icon: 'lock',
            id: 'admin.archive.impact.interactions',
            value: data.openInteractionsBecomingReadOnly,
          },
          {
            icon: 'logout',
            id: 'admin.archive.impact.portal',
            value: data.portalUsersSignedOut,
          },
        ];

  const archive = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    // The check above is case-insensitive; the API compares the name exactly
    // (D-L46). Once the person has shown they know WHICH programme, the
    // request carries its canonical name rather than their capitalisation.
    const result = await archiveProgramme(programmeId, programmeName);
    setBusy(false);
    if (result.ok) {
      onArchived?.();
      onClose();
      return;
    }
    setError(result.error);
  };

  return (
    <Dialog
      title={t.t('admin.archive.title', { name: programmeName })}
      body={t.t('admin.archive.body', { days: data?.restorableUntilDays ?? 30 })}
      icon="archive"
      tone="danger"
      testId="archive-dialog"
      closeLabel={t.t('admin.dialog.close')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            data-testid="archive-cancel"
            onClick={onClose}
            className={SECONDARY_BUTTON}
          >
            {t.t('admin.archive.cancel')}
          </button>
          <button
            type="button"
            data-testid="archive-confirm"
            disabled={busy || !matches}
            onClick={() => void archive()}
            className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary hover:bg-danger-hover disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.t('admin.archive.confirm')}
          </button>
        </>
      }
    >
      {preview.slow ? (
        <StillConnecting t={t} />
      ) : preview.error !== null ? (
        <ErrorPanel t={t} error={preview.error} onRetry={preview.reload} />
      ) : data === null ? (
        <Skeleton rows={3} label={t.t('admin.loading')} />
      ) : (
        <ul
          data-testid="archive-impacts"
          className="flex list-none flex-col gap-2 rounded-md bg-surface-sunken p-4"
        >
          {impacts.map((impact) => (
            <li key={impact.id} className="flex gap-2 text-body-sm">
              <Icon name={impact.icon} size="sm" className="text-text-2" />
              {t.t(impact.id, { count: impact.value })}
            </li>
          ))}
          {/* Null means we do not know which rule applies. Nothing is better
              than a rule we invented — see the note at the top. */}
          {data.retentionSummary === null || data.retentionSummary === undefined ? null : (
            <li data-testid="archive-retention" className="flex gap-2 text-body-sm">
              <Icon name="inventory_2" size="sm" className="text-text-2" />
              {t.t('admin.archive.impact.retention', { rule: data.retentionSummary })}
            </li>
          )}
        </ul>
      )}

      <label className="flex flex-col gap-2 text-body-sm font-bold">
        {t.t('admin.archive.typeName', { name: programmeName })}
        <input
          type="text"
          autoComplete="off"
          data-testid="archive-confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md font-normal text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      </label>

      {error === null ? null : (
        <p
          role="alert"
          data-testid="archive-error"
          data-error-code={error.code}
          className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
        >
          {t.t(errorMessageId(error))}
        </p>
      )}
    </Dialog>
  );
}
