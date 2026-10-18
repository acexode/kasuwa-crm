'use client';

import { useEffect, useRef, useState } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import { SECONDARY_BUTTON } from '../../auth/button-classes';
import type { ScreenError } from '../../../lib/admin-api';
import { retireCustomField, type CustomFieldDefinition } from '../../../lib/custom-fields-api';
import { Dialog } from '../dialog';
import { errorText } from './studio-text';

/**
 * `P18/B` — the retire confirmation. RETIRE, NEVER DELETE (D-L128 Q3): the
 * definition keeps its api name for ever, so a new field can never reinterpret
 * old values, and there is no way back. That is said in the dialog's own words
 * before anything is sent.
 *
 * Escape and Cancel send nothing and give focus back to the control that opened
 * it (`Dialog` owns that, and the focus trap). Confirm sends one POST with no
 * body; a refusal is drawn inside the dialog, which stays open, as a translated
 * `role="alert"` (the API's 403 is the write gate, D-L84).
 */

export function RetireDialog({
  t,
  field,
  onClose,
  onRetired,
  onStale,
}: {
  t: Translator;
  field: CustomFieldDefinition;
  onClose: () => void;
  onRetired: () => void;
  /** The field is gone or already changed under us: the list should be read again. */
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ScreenError | null>(null);
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  // The refusal is reached, not only announced: focus stays inside the dialog.
  useEffect(() => {
    if (refusal !== null) alertRef.current?.focus();
  }, [refusal]);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    const result = await retireCustomField(field.id);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      onRetired();
      return;
    }
    setRefusal(result.error);
    if (result.error.code === 'not_found') onStale();
  };

  return (
    <Dialog
      testId="retire-dialog"
      icon="archive"
      tone="warning"
      title={t.t('admin.studio.custom.retire.title', { label: field.label })}
      body={t.t('admin.studio.custom.retire.body', { apiName: field.apiName })}
      closeLabel={t.t('admin.dialog.close')}
      onClose={onClose}
      footer={
        <>
          <button type="button" data-testid="retire-cancel" onClick={onClose} className={SECONDARY_BUTTON}>
            {t.t('admin.studio.custom.form.cancel')}
          </button>
          <button
            type="button"
            data-testid="retire-confirm"
            aria-disabled={busy}
            onClick={() => void confirm()}
            className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary hover:bg-danger-hover aria-disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.t(busy ? 'admin.studio.custom.retire.retiring' : 'admin.studio.custom.retire.confirm')}
          </button>
        </>
      }
    >
      {refusal === null ? null : (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          className="flex gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Icon name="error" size="sm" />
          <p>{errorText(t, refusal)}</p>
        </div>
      )}
    </Dialog>
  );
}
