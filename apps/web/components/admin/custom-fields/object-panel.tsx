'use client';

import { useEffect, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import { PRIMARY_BUTTON, QUIET_BUTTON } from '../../auth/button-classes';
import { formatCount } from '../../../lib/admin-format';
import { fullState } from '../../../lib/custom-field-model';
import {
  listCustomFields,
  type CustomFieldDefinition,
  type CustomFieldObject,
} from '../../../lib/custom-fields-api';
import { ErrorPanel, Panel, StillConnecting } from '../panel';
import { useResource } from '../use-resource';
import { FieldForm, type SavedKind } from './field-form';
import { RetireDialog } from './retire-dialog';
import { CLASSIFICATION_LABEL, TYPE_LABEL } from './studio-text';

/**
 * `P18/B` — one object's custom fields: the limits meter, the list, the "show
 * retired" control, and the create and edit form and retire dialog that open
 * over it.
 *
 * Keyed by object by the screen, so switching objects starts from nothing:
 * another object's rows are never drawn under this object's name while its own
 * are on the way (the skeleton, then the slow-link offer, are `Panel`'s).
 *
 * ONE READ, RETIRED INCLUDED. The list is read with `includeRetired=true` and
 * filtered here, so "show retired" costs no second request on a 256 kbps link,
 * and the active count is the contract's own definition (retired fields do not
 * count towards the limit). A write is followed by a read: the list shows what
 * the server now holds, not what this screen hopes it holds.
 *
 * Retired fields are read-only and there is no restore (D-L128 Q3).
 */

type FormState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly field: CustomFieldDefinition };

const STATUS: Readonly<Record<SavedKind | 'retired', MessageId>> = {
  created: 'admin.studio.custom.status.created',
  updated: 'admin.studio.custom.status.updated',
  retired: 'admin.studio.custom.status.wasRetired',
};

export function ObjectPanel({
  t,
  locale,
  object,
  onFormState,
}: {
  t: Translator;
  locale: string;
  object: CustomFieldObject;
  /** Stable. What leaving would lose, and whether a write is in flight, for the screen's guards. */
  onFormState: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const list = useResource((signal) => listCustomFields(object, signal), [object]);
  const [showRetired, setShowRetired] = useState(false);
  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [retiring, setRetiring] = useState<CustomFieldDefinition | null>(null);
  const [status, setStatus] = useState<MessageId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const focusNewAfterRead = useRef(false);

  // After a retire the row that opened the dialog is gone: focus goes to the
  // create control once the list has been read, not to the top of the page.
  useEffect(() => {
    if (focusNewAfterRead.current && list.data !== null) {
      focusNewAfterRead.current = false;
      newButton.current?.focus();
    }
  }, [list.data]);

  // A form on a field that has since been retired (or has gone) has nothing left to edit.
  useEffect(() => {
    if (form.kind !== 'edit' || list.data === null) return;
    const editing = form.field.id;
    const current = list.data.items.find((item) => item.id === editing);
    if (current === undefined || current.retiredAt !== null) setForm({ kind: 'closed' });
  }, [list.data, form]);

  const open = (next: FormState, from: HTMLElement) => {
    opener.current = from;
    setStatus(null);
    setForm(next);
  };

  const closeForm = () => {
    setForm({ kind: 'closed' });
    const from = opener.current;
    if (from !== null && document.contains(from)) from.focus();
  };

  const saved = (kind: SavedKind) => {
    setStatus(STATUS[kind]);
    closeForm();
    list.reload();
  };

  return (
    // With data in hand a slow or failed RELOAD is drawn beside it, never instead of it:
    // swapping the panel out would unmount the open form and dialog under the admin's hands.
    <Panel t={t} resource={list.data === null ? list : { ...list, slow: false, error: null }}>
      {(data) => {
        const active = data.items.filter((item) => item.retiredAt === null);
        const shown = showRetired ? data.items : active;
        const state = fullState(data.items, data.limits);
        const full = state !== 'open';
        const percent = Math.min(100, Math.round((active.length / data.limits.fieldsPerObject) * 100));

        return (
          <div className="flex flex-col gap-4">
            {list.slow ? <StillConnecting t={t} /> : null}
            {list.error === null ? null : <ErrorPanel t={t} error={list.error} onRetry={list.reload} />}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div data-testid="field-limit" className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-body-sm text-text-2">
                  {t.t('admin.studio.custom.limit', {
                    active: formatCount(locale, active.length),
                    limit: formatCount(locale, data.limits.fieldsPerObject),
                  })}
                </span>
                <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <span
                    className={`block h-full rounded-full ${full ? 'bg-warning' : 'bg-primary'}`}
                    style={{ inlineSize: `${percent}%` }}
                  />
                </span>
              </div>

              <label className="flex min-h-touch items-center gap-2 text-body-sm">
                <input
                  type="checkbox"
                  data-testid="show-retired"
                  checked={showRetired}
                  onChange={(event) => setShowRetired(event.target.checked)}
                  className="h-5 w-5 accent-primary"
                />
                {t.t('admin.studio.custom.showRetired')}
              </label>

              {full ? null : (
                <button
                  ref={newButton}
                  type="button"
                  data-testid="field-new"
                  onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
                  className={PRIMARY_BUTTON}
                >
                  <Icon name="add" size="sm" />
                  {t.t('admin.studio.custom.new')}
                </button>
              )}
            </div>

            {full ? (
              <p role="note" data-testid="limit-note" className="flex gap-2 rounded-md bg-warning-soft p-3 text-body-sm text-warning-text">
                <Icon name="warning" size="sm" />
                {t.t(state === 'definitions' ? 'admin.studio.custom.limit.definitions' : 'admin.studio.custom.error.field_limit_reached')}
              </p>
            ) : null}

            <div role="status">
              {status === null ? null : (
                <p
                  data-testid="studio-status"
                  className="flex gap-2 rounded-md bg-success-soft p-3 text-body-sm text-success-text"
                >
                  <Icon name="check_circle" size="sm" />
                  {t.t(status)}
                </p>
              )}
            </div>

            {form.kind === 'closed' ? null : (
              <FieldForm
                key={form.kind === 'edit' ? form.field.id : 'create'}
                t={t}
                mode={form.kind}
                object={object}
                {...(form.kind === 'edit' ? { field: form.field } : {})}
                limits={data.limits}
                onSaved={saved}
                onCancel={closeForm}
                onStale={list.reload}
                onState={onFormState}
              />
            )}

            {shown.length === 0 ? (
              <p
                data-testid="fields-empty"
                className="rounded-lg border border-dashed border-border-strong p-6 text-center text-body-md text-text-2"
              >
                {t.t('admin.studio.custom.empty')}
              </p>
            ) : (
              <ul aria-label={t.t('admin.studio.custom.title')} className="flex flex-col gap-2">
                {shown.map((item) => (
                  <li
                    key={item.id}
                    data-field-row={item.apiName}
                    data-type={item.type}
                    data-classification={item.classification}
                    data-retired={item.retiredAt === null ? 'false' : 'true'}
                    className={`flex flex-wrap items-start gap-3 rounded-lg border border-border p-3 ${
                      item.retiredAt === null ? 'bg-surface' : 'bg-surface-sunken'
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span data-record-text className="break-words text-body-md font-semibold">
                        {item.label}
                      </span>
                      <code data-record-text className="break-all font-mono text-mono text-text-2">
                        {item.apiName}
                      </code>
                      {item.description === null || item.description === '' ? null : (
                        <span data-record-text className="break-words text-body-sm text-text-muted">
                          {item.description}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-caption font-bold">
                      <span className="rounded-full bg-surface-sunken px-2 py-1 text-text-2">
                        {t.t(TYPE_LABEL[item.type])}
                      </span>
                      {item.classification === 'none' ? null : (
                        <span className="rounded-full bg-warning-soft px-2 py-1 text-warning-text">
                          {t.t(CLASSIFICATION_LABEL[item.classification])}
                        </span>
                      )}
                      {item.retiredAt === null ? null : (
                        <span className="rounded-full bg-danger-soft px-2 py-1 text-danger-text">
                          {t.t('admin.studio.custom.retired')}
                        </span>
                      )}
                    </div>

                    {item.retiredAt !== null ? null : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          data-testid="field-edit"
                          onClick={(event) => open({ kind: 'edit', field: item }, event.currentTarget)}
                          className={QUIET_BUTTON}
                        >
                          {t.t('admin.studio.custom.edit')}
                          <span data-record-text className="sr-only">
                            {item.label}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid="field-retire"
                          onClick={(event) => {
                            opener.current = event.currentTarget;
                            setRetiring(item);
                          }}
                          className={QUIET_BUTTON}
                        >
                          {t.t('admin.studio.custom.retire')}
                          <span data-record-text className="sr-only">
                            {item.label}
                          </span>
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {retiring === null ? null : (
              <RetireDialog
                t={t}
                field={retiring}
                onClose={() => setRetiring(null)}
                onStale={list.reload}
                onRetired={() => {
                  setRetiring(null);
                  setStatus(STATUS.retired);
                  focusNewAfterRead.current = true;
                  list.reload();
                }}
              />
            )}
          </div>
        );
      }}
    </Panel>
  );
}
