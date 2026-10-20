'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import { useUnsavedGuard } from './use-unsaved-guard';
import {
  applyBulk,
  canEdit,
  canRead,
  cellKey,
  loadedLevels,
  pendingChanges,
  toggleEdit,
  toggleRead,
  type CellDraft,
} from './field-security-model';
import type { LanguageOption } from '../auth/language-menu';
import { Checkbox } from '@kasuwa/ui/components';
import { AdminButton, CARD, ChipCount, Notice, PageHeader, SearchField, TEXT_ACTION, UnsavedBar, chipClass } from './admin-ui';
import {
  getFieldSecurityMatrix,
  listFieldSecurityObjects,
  listPermissionSets,
  saveFieldSecurityMatrix,
  type FieldAccessLevel,
  type FieldClassification,
  type ScreenError,
} from '../../lib/admin-api';
import { formatCount } from '../../lib/admin-format';

/**
 * `P02/D`, `P02/D1`, `P02/D2` — field-level security.
 *
 * ---------------------------------------------------------------------------
 * TWO AXES, AND THE SECOND ONE IS NOT PROGRAMME (D-P9)
 *
 * The matrix is field × permission set, tenant-wide, and there is deliberately
 * no programme selector on this screen. Programme scoping comes from
 * ASSIGNMENT: `user_programme` carries the permission set that applies to a
 * person in that programme. A BPO that must honour two clients with different
 * contractual rules about the same Contact field gives their agents different
 * permission sets — it does not store the same field twice at two levels.
 *
 * If this screen ever seems to want a third axis, it does not. Adding one
 * would make one admin's save silently overwrite another programme's settings,
 * which is the failure the decision was taken to avoid.
 *
 * ---------------------------------------------------------------------------
 * THE SAVE IS CELL-LEVEL, INCLUDING WHEN A BULK ACTION PRODUCED IT
 *
 * `changes` carries one entry per `(field, permission set)` that actually
 * differs. Every one of them is a separate audit row when the endpoint is
 * built; a bulk action that touched forty cells and wrote one row saying "bulk
 * edit" is not an audit trail. The endpoint is not written yet, so the request
 * shape is the whole of what this build can get right — and it is got right
 * here rather than deferred.
 *
 * `version` comes from the last `GET`. A stale one is `409 stale_write`: the
 * screen re-reads so the admin sees what their colleague saved, because
 * silently overwriting them is precisely what the version exists to prevent.
 * ---------------------------------------------------------------------------
 *
 * The matrix never carries a field's data — no sample value, no record count.
 * A helpful preview of the BVN column would be the exact leak this screen
 * exists to prevent, and the client renders nothing that is not in the schema.
 */

/** PII is information (info), sensitive is a risk (danger), as the export tags them. */
const CLASSIFICATION_TONE: Readonly<Record<FieldClassification, string>> = {
  none: '',
  pii: 'bg-info-soft text-info-text',
  sensitive: 'bg-danger-soft text-danger-text',
};

/**
 * The matrix's two toggles, 36 by 32 at radius 6 (`P02/D`). Read on is the
 * soft primary; edit on is SOLID primary, so the two read apart at a glance;
 * off is a bare border with a muted glyph. Admin's locked cells keep their
 * colours (no fade) and refuse the pointer.
 */
function accessToggleClass(on: boolean, strong: boolean): string {
  const tone = !on
    ? 'border-border bg-transparent text-text-muted is-hover:bg-surface-sunken'
    : strong
      ? 'border-primary bg-primary text-on-primary'
      : 'border-primary-soft-strong bg-primary-soft text-primary-text';
  return `flex h-8 w-9 items-center justify-center rounded-6 border outline-none is-focus-visible:ring-focus disabled:cursor-not-allowed ${tone}`;
}

const BULK_LEVELS: readonly FieldAccessLevel[] = ['none', 'read', 'edit'];

export function FieldSecurityScreen({
  locale,
  messages,
  locales,
  linkedSettings,
  bell,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();

  const objects = useResource((signal) => listFieldSecurityObjects(signal), []);
  const sets = useResource((signal) => listPermissionSets(signal), []);

  const [objectApiName, setObjectApiName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [draft, setDraft] = useState<CellDraft>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkSet, setBulkSet] = useState('*');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScreenError | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const firstObject = objects.data?.items[0]?.objectApiName ?? null;
  const activeObject = objectApiName ?? firstObject;

  /**
   * `q` and `sensitiveOnly` are SERVER filters, per the contract. Filtering in
   * the browser would mean the footer's "N of M fields" counted a page rather
   * than the object, and would quietly stop working the moment an object has
   * more fields than one response carries.
   */
  const matrix = useResource(
    useCallback(
      (signal: AbortSignal) =>
        activeObject === null
          ? Promise.resolve({ ok: false as const, error: { code: 'not_found' as const } })
          : getFieldSecurityMatrix(
              { object: activeObject, q: query, sensitiveOnly },
              signal,
            ),
      [activeObject, query, sensitiveOnly],
    ),
    [activeObject, query, sensitiveOnly],
  );

  // Switching object abandons nothing silently: the unsaved bar is still there
  // and still counts the other object's edits, because `draft` is keyed by
  // field api name and a save only ever sends the active object's changes.
  const data = matrix.data;
  const loaded = useMemo(() => (data === null ? new Map() : loadedLevels(data)), [data]);
  const changes = useMemo(
    () => (data === null ? [] : pendingChanges(data, draft)),
    [data, draft],
  );

  const onIntercept = useCallback((destination: string) => setPendingHref(destination), []);
  useUnsavedGuard(changes.length > 0, onIntercept);

  useEffect(() => {
    if (changes.length === 0) setSaveError(null);
  }, [changes.length]);

  const columns = sets.data?.items ?? [];

  const levelOf = (fieldApiName: string, permissionSetId: string, fallback: FieldAccessLevel) =>
    draft.get(cellKey(fieldApiName, permissionSetId)) ??
    loaded.get(cellKey(fieldApiName, permissionSetId)) ??
    fallback;

  const setLevel = (fieldApiName: string, permissionSetId: string, level: FieldAccessLevel) =>
    setDraft((current) => {
      const next = new Map(current);
      next.set(cellKey(fieldApiName, permissionSetId), level);
      return next;
    });

  const bulk = (level: FieldAccessLevel) => {
    if (data === null) return;
    const targets =
      bulkSet === '*'
        ? columns.filter((column) => !column.locked).map((column) => column.permissionSetId)
        : [bulkSet];
    setDraft((current) => applyBulk(data, current, selected, targets, level));
  };

  const save = async () => {
    if (data === null || changes.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const result = await saveFieldSecurityMatrix({
      objectApiName: data.objectApiName,
      version: data.version,
      changes,
    });
    setSaving(false);
    if (result.ok) {
      setDraft(new Map());
      setSelected(new Set());
      setToast(t.t('admin.fls.saved', { count: changes.length }));
      matrix.reload();
      return;
    }
    setSaveError(result.error);
    if (result.error.code === 'stale_write') matrix.reload();
  };

  const rows = data?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.fieldApiName));

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="fls"
    >
      <div data-screen="P02/D" className="flex flex-col gap-6 pb-24">
        <PageHeader
          eyebrow={t.t('admin.fls.eyebrow')}
          title={t.t('admin.fls.title')}
          intro={
            <>
              <p className="m-0">{t.t('admin.fls.intro')}</p>
              {/* The decision made visible. An admin looking for a programme
                  selector has to be told where programme scoping lives, or
                  they will conclude the screen is unfinished. */}
              <p data-testid="fls-scope-note" className="m-0 mt-1 text-meta text-text-muted">
                {t.t('admin.fls.scope.note')}
              </p>
            </>
          }
        />

        <Panel t={t} resource={objects} skeletonRows={1}>
          {(objectList) => (
            <div role="tablist" aria-label={t.t('admin.fls.objects')} className="-mt-2 flex flex-wrap gap-1.5">
              {objectList.items.map((object) => {
                const active = object.objectApiName === activeObject;
                return (
                  <button
                    key={object.objectApiName}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid="fls-object"
                    data-object={object.objectApiName}
                    onClick={() => {
                      setObjectApiName(object.objectApiName);
                      setSelected(new Set());
                    }}
                    className={chipClass(active, 'tab')}
                  >
                    {object.label}
                    <ChipCount small>{formatCount(locale, object.fieldCount)}</ChipCount>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>

        <div className="-mt-2 flex flex-wrap items-center gap-3">
          <SearchField
            id="fls-search"
            label={t.t('admin.fls.search')}
            data-testid="fls-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.t('admin.fls.search')}
            className="w-full sm:w-72"
          />
          <button
            type="button"
            data-testid="fls-sensitive-only"
            aria-pressed={sensitiveOnly}
            onClick={() => setSensitiveOnly((value) => !value)}
            className="inline-flex h-control-md items-center gap-2 rounded-md border border-border bg-surface px-3 text-body-sm font-semibold text-text outline-none is-hover:bg-surface-sunken is-focus-visible:ring-focus"
          >
            <span
              aria-hidden="true"
              className={`flex size-4.5 items-center justify-center rounded-sm border-2 ${
                sensitiveOnly ? 'border-primary bg-primary text-on-primary' : 'border-text-2'
              }`}
            >
              {sensitiveOnly ? <Icon name="check" size={14} /> : null}
            </span>
            {t.t('admin.fls.sensitiveOnly')}
          </button>
          <span className="hidden flex-1 lg:block" />
          <span className="flex flex-wrap items-center gap-3.5 text-meta text-text-2">
            <span className="inline-flex items-center gap-1">
              <Icon name="visibility" size={18} />
              {t.t('admin.fls.legend.read')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="edit" size={18} />
              {t.t('admin.fls.legend.edit')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-3.5 rounded-sm border border-accent bg-accent-soft" />
              {t.t('admin.fls.legend.changed')}
            </span>
          </span>
        </div>

        {selected.size === 0 ? null : (
          <div
            role="region"
            aria-label={t.t('admin.fls.bulk.region')}
            data-testid="fls-bulk"
            className="-mt-2 flex flex-wrap items-center gap-2.5 rounded-10 border border-primary-soft-strong bg-primary-soft py-2.5 pe-3 ps-4"
          >
            <b className="text-body-sm font-bold text-primary-text">
              {t.t('admin.fls.bulk.selected', { count: selected.size })}
            </b>
            <label htmlFor="fls-bulk-set" className="text-body-sm">
              {t.t('admin.fls.bulk.setFor')}
            </label>
            <select
              id="fls-bulk-set"
              data-testid="fls-bulk-set"
              value={bulkSet}
              onChange={(event) => setBulkSet(event.target.value)}
              className="h-control-sm cursor-pointer rounded-md border border-border-strong bg-surface ps-2.5 pe-2 text-body-sm text-text is-focus:field-focus"
            >
              <option value="*">{t.t('admin.fls.bulk.allUnlocked')}</option>
              {columns
                .filter((column) => !column.locked)
                .map((column) => (
                  <option key={column.permissionSetId} value={column.permissionSetId}>
                    {column.label}
                  </option>
                ))}
            </select>
            <div className="flex flex-wrap gap-1.5">
              {BULK_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-testid={`fls-bulk-${level}`}
                  onClick={() => bulk(level)}
                  className="inline-flex h-control-sm items-center rounded-md border border-border bg-surface px-3 text-meta font-semibold text-text outline-none is-hover:bg-surface-sunken is-focus-visible:ring-focus"
                >
                  {t.t(`admin.fls.bulk.${level}` as MessageId)}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            <button
              type="button"
              data-testid="fls-bulk-clear"
              onClick={() => setSelected(new Set())}
              className={`${TEXT_ACTION} h-control-sm`}
            >
              {t.t('admin.fls.bulk.clear')}
            </button>
          </div>
        )}

        <Panel t={t} resource={matrix} skeletonRows={10}>
          {(loadedMatrix) => (
            <div className={`${CARD} overflow-auto`}>
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.fls.title')}</caption>
                <thead className="bg-surface-sunken">
                  <tr className="border-b border-border">
                    <th
                      scope="col"
                      className="sticky start-0 z-10 min-w-72 border-e border-border bg-surface-sunken py-1 pe-4 ps-2 text-start"
                    >
                      <span className="flex items-center gap-1">
                        <Checkbox
                          size="compact"
                          data-testid="fls-select-all"
                          aria-label={t.t('admin.fls.selectAll')}
                          checked={allSelected}
                          indeterminate={!allSelected && selected.size > 0}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(loadedMatrix.rows.map((row) => row.fieldApiName))
                                : new Set(),
                            )
                          }
                        />
                        <span className="text-caption font-bold uppercase tracking-wider text-text-muted">
                          {t.t('admin.fls.col.field')}
                        </span>
                      </span>
                    </th>
                    {columns.map((column) => (
                      <th
                        key={column.permissionSetId}
                        scope="col"
                        className="min-w-28 border-s border-border px-2 py-2.5 text-center"
                      >
                        <span className="flex items-center justify-center gap-1 text-meta font-bold text-text">
                          {column.label}
                          {column.locked ? (
                            <Icon name="lock" size={15} className="text-text-muted" />
                          ) : null}
                        </span>
                        <span className="block text-caption font-normal text-text-muted">
                          {column.userCount === null || column.userCount === undefined
                            ? t.t('admin.prog.unknown')
                            : t.t('admin.fls.users', { count: column.userCount })}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loadedMatrix.rows.map((row) => {
                    const rowSelected = selected.has(row.fieldApiName);
                    return (
                    <tr
                      key={row.fieldApiName}
                      data-testid="fls-row"
                      data-field={row.fieldApiName}
                      className={`border-b border-border last:border-b-0 ${rowSelected ? 'bg-primary-soft' : ''}`}
                    >
                      <th
                        scope="row"
                        className={`sticky start-0 border-e border-border py-1.5 pe-4 ps-2 text-start font-normal ${
                          rowSelected ? 'bg-primary-soft' : 'bg-surface'
                        }`}
                      >
                        <span className="flex items-center gap-1">
                          <Checkbox
                            size="compact"
                            data-testid="fls-select-row"
                            aria-label={t.t('admin.fls.select', { label: row.label })}
                            checked={rowSelected}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(row.fieldApiName);
                                else next.delete(row.fieldApiName);
                                return next;
                              })
                            }
                          />
                          <span className="flex min-w-0 flex-col gap-px">
                            <span className="flex items-center gap-1.5 font-semibold">
                              {row.label}
                              {row.classification === 'none' ? null : (
                                <span
                                  className={`inline-flex h-5 items-center rounded-sm px-1.5 text-micro ${CLASSIFICATION_TONE[row.classification]}`}
                                >
                                  {t.t(`admin.fls.class.${row.classification}` as MessageId)}
                                </span>
                              )}
                            </span>
                            <span className="font-mono text-caption font-normal text-text-muted">
                              {row.fieldApiName}
                            </span>
                          </span>
                        </span>
                      </th>
                      {row.cells.map((cell) => {
                        const level = levelOf(row.fieldApiName, cell.permissionSetId, cell.level);
                        const changed = level !== cell.level;
                        const setLabel =
                          columns.find(
                            (column) => column.permissionSetId === cell.permissionSetId,
                          )?.label ?? cell.permissionSetId;
                        return (
                          <td
                            key={cell.permissionSetId}
                            data-testid="fls-cell"
                            data-set={cell.permissionSetId}
                            data-level={level}
                            data-changed={changed}
                            className={`border-s border-border px-2 ${changed ? 'bg-accent-soft' : ''}`}
                          >
                            <span className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                data-testid="fls-read"
                                aria-pressed={canRead(level)}
                                disabled={cell.locked}
                                aria-label={t.t('admin.fls.cell.read', {
                                  field: row.label,
                                  set: setLabel,
                                })}
                                onClick={() =>
                                  setLevel(
                                    row.fieldApiName,
                                    cell.permissionSetId,
                                    toggleRead(level),
                                  )
                                }
                                className={accessToggleClass(canRead(level), false)}
                              >
                                <Icon name="visibility" size={18} />
                              </button>
                              <button
                                type="button"
                                data-testid="fls-edit"
                                aria-pressed={canEdit(level)}
                                disabled={cell.locked}
                                aria-label={t.t('admin.fls.cell.edit', {
                                  field: row.label,
                                  set: setLabel,
                                })}
                                onClick={() =>
                                  setLevel(
                                    row.fieldApiName,
                                    cell.permissionSetId,
                                    toggleEdit(level),
                                  )
                                }
                                className={accessToggleClass(canEdit(level), true)}
                              >
                                <Icon name="edit" size={18} />
                              </button>
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </tbody>
              </table>

              {loadedMatrix.rows.length > 0 ? null : (
                <div
                  data-testid="fls-no-results"
                  className="flex flex-col items-center gap-2.5 px-6 py-14 text-center"
                >
                  <span className="flex size-16 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                    <Icon name="search_off" size={32} />
                  </span>
                  <b className="text-h5 font-bold">{t.t('admin.fls.noResults')}</b>
                  <AdminButton
                    data-testid="fls-clear-search"
                    onClick={() => {
                      setQuery('');
                      setSensitiveOnly(false);
                    }}
                    className="mt-1.5"
                  >
                    {t.t('admin.fls.clearSearch')}
                  </AdminButton>
                </div>
              )}
            </div>
          )}
        </Panel>

        <p data-testid="fls-footer" className="-mt-2 m-0 text-meta text-text-muted">
          {t.t('admin.fls.footer', {
            shown: rows.length,
            total: data?.totalFieldCount ?? rows.length,
          })}
        </p>

        {saveError === null ? null : (
          <Notice tone="danger" testId="fls-save-error" errorCode={saveError.code}>
            {t.t(errorMessageId(saveError))}
          </Notice>
        )}

        {toast === null ? null : (
          <Notice tone="success" testId="fls-toast">
            {toast}
          </Notice>
        )}
      </div>

      {changes.length === 0 ? null : (
        <UnsavedBar
          label={t.t('admin.unsaved.region')}
          count={t.t('admin.unsaved.count', { count: changes.length })}
          detail={t.t('admin.fls.unsaved', { count: changes.length })}
          discardLabel={t.t('admin.unsaved.discard')}
          saveLabel={t.t('admin.unsaved.save')}
          savingLabel={t.t('admin.unsaved.saving')}
          saving={saving}
          onDiscard={() => {
            setDraft(new Map());
            setToast(t.t('admin.unsaved.discarded'));
          }}
          onSave={() => void save()}
        />
      )}

      {pendingHref === null ? null : (
        <Dialog
          title={t.t('admin.leave.title')}
          body={t.t('admin.leave.body')}
          icon="edit_note"
          tone="warning"
          testId="leave-dialog"
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setPendingHref(null)}
          footer={
            <>
              <AdminButton data-testid="leave-cancel" onClick={() => setPendingHref(null)}>
                {t.t('admin.leave.cancel')}
              </AdminButton>
              <AdminButton
                variant="danger"
                data-testid="leave-confirm"
                onClick={() => {
                  const destination = pendingHref;
                  setPendingHref(null);
                  setDraft(new Map());
                  router.push(destination);
                }}
              >
                {t.t('admin.leave.confirm')}
              </AdminButton>
            </>
          }
        >
          <p className="m-0 rounded-10 bg-surface-sunken px-3.5 py-3 text-meta">
            {t.t('admin.fls.unsaved', { count: changes.length })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}
