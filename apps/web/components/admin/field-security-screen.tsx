'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n';
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
import { SECONDARY_BUTTON } from '../auth/button-classes';
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

const CLASSIFICATION_TONE: Readonly<Record<FieldClassification, string>> = {
  none: '',
  pii: 'bg-warning-soft text-warning-text',
  sensitive: 'bg-danger-soft text-danger-text',
};

const BULK_LEVELS: readonly FieldAccessLevel[] = ['none', 'read', 'edit'];

export function FieldSecurityScreen({
  locale,
  messages,
  locales,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
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
    <AdminShell locale={locale} messages={messages} locales={locales} activeSettingId="fls">
      <div data-screen="P02/D" className="flex flex-col gap-4 pb-24">
        <div className="flex flex-col gap-2">
          <span className="text-body-sm font-semibold text-text-muted">
            {t.t('admin.fls.eyebrow')}
          </span>
          <h1 className="text-h2">{t.t('admin.fls.title')}</h1>
          <p className="max-w-prose text-body-md text-text-2">{t.t('admin.fls.intro')}</p>
          {/* The decision made visible. An admin looking for a programme
              selector has to be told where programme scoping lives, or they
              will conclude the screen is unfinished. */}
          <p data-testid="fls-scope-note" className="max-w-prose text-body-sm text-text-muted">
            {t.t('admin.fls.scope.note')}
          </p>
        </div>

        <Panel t={t} resource={objects} skeletonRows={1}>
          {(objectList) => (
            <div role="tablist" aria-label={t.t('admin.fls.objects')} className="flex flex-wrap gap-2">
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
                    className={`flex min-h-touch items-center gap-2 rounded-md border px-3 text-body-md font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                      active
                        ? 'border-primary bg-primary-soft text-primary-text'
                        : 'border-border bg-surface text-text'
                    }`}
                  >
                    {object.label}
                    <span className="text-body-sm font-normal text-text-muted">
                      {formatCount(locale, object.fieldCount)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="fls-search" className="sr-only">
            {t.t('admin.fls.search')}
          </label>
          <input
            id="fls-search"
            type="search"
            data-testid="fls-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.t('admin.fls.search')}
            className="min-h-touch min-w-0 flex-[0_1_280px] rounded-md border border-border-strong bg-surface px-3 text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <button
            type="button"
            data-testid="fls-sensitive-only"
            aria-pressed={sensitiveOnly}
            onClick={() => setSensitiveOnly((value) => !value)}
            className={`flex min-h-touch items-center gap-2 rounded-md border px-3 text-body-md font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              sensitiveOnly
                ? 'border-primary bg-primary-soft text-primary-text'
                : 'border-border bg-surface text-text'
            }`}
          >
            <Icon name={sensitiveOnly ? 'check' : 'visibility'} size="sm" />
            {t.t('admin.fls.sensitiveOnly')}
          </button>
          <span className="flex flex-wrap items-center gap-3 text-body-sm text-text-2">
            <span className="inline-flex items-center gap-1">
              <Icon name="visibility" size="sm" />
              {t.t('admin.fls.legend.read')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="edit_note" size="sm" />
              {t.t('admin.fls.legend.edit')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="h-3 w-3 rounded-sm border border-accent bg-accent-soft" />
              {t.t('admin.fls.legend.changed')}
            </span>
          </span>
        </div>

        {selected.size === 0 ? null : (
          <div
            role="region"
            aria-label={t.t('admin.fls.bulk.region')}
            data-testid="fls-bulk"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-primary bg-primary-soft p-3"
          >
            <b className="text-body-md text-primary-text">
              {t.t('admin.fls.bulk.selected', { count: selected.size })}
            </b>
            <label htmlFor="fls-bulk-set" className="text-body-md">
              {t.t('admin.fls.bulk.setFor')}
            </label>
            <select
              id="fls-bulk-set"
              data-testid="fls-bulk-set"
              value={bulkSet}
              onChange={(event) => setBulkSet(event.target.value)}
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
            <div className="flex flex-wrap gap-2">
              {BULK_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-testid={`fls-bulk-${level}`}
                  onClick={() => bulk(level)}
                  className={SECONDARY_BUTTON}
                >
                  {t.t(`admin.fls.bulk.${level}` as MessageId)}
                </button>
              ))}
            </div>
            <button
              type="button"
              data-testid="fls-bulk-clear"
              onClick={() => setSelected(new Set())}
              className={`${SECONDARY_BUTTON} border-0 bg-transparent text-primary-text`}
            >
              {t.t('admin.fls.bulk.clear')}
            </button>
          </div>
        )}

        <Panel t={t} resource={matrix} skeletonRows={10}>
          {(loadedMatrix) => (
            <div className="overflow-auto rounded-lg border border-border bg-surface">
              <table className="w-full min-w-max border-collapse text-body-sm">
                <caption className="sr-only">{t.t('admin.fls.title')}</caption>
                <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                  <tr>
                    <th scope="col" className="p-3 text-start font-bold">
                      <span className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          data-testid="fls-select-all"
                          aria-label={t.t('admin.fls.selectAll')}
                          checked={allSelected}
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(loadedMatrix.rows.map((row) => row.fieldApiName))
                                : new Set(),
                            )
                          }
                          className="h-5 w-5 accent-primary"
                        />
                        {t.t('admin.fls.col.field')}
                      </span>
                    </th>
                    {columns.map((column) => (
                      <th
                        key={column.permissionSetId}
                        scope="col"
                        className="border-s border-border p-3 text-center font-bold"
                      >
                        <span className="flex items-center justify-center gap-1 text-body-sm">
                          {column.label}
                          {column.locked ? (
                            <Icon name="lock" size="sm" className="text-text-muted" />
                          ) : null}
                        </span>
                        <span className="block font-normal normal-case text-text-muted">
                          {column.userCount === null || column.userCount === undefined
                            ? t.t('admin.prog.unknown')
                            : t.t('admin.fls.users', { count: column.userCount })}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loadedMatrix.rows.map((row) => (
                    <tr
                      key={row.fieldApiName}
                      data-testid="fls-row"
                      data-field={row.fieldApiName}
                      className="border-t border-border"
                    >
                      <th scope="row" className="p-3 text-start font-normal">
                        <span className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            data-testid="fls-select-row"
                            aria-label={t.t('admin.fls.select', { label: row.label })}
                            checked={selected.has(row.fieldApiName)}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(row.fieldApiName);
                                else next.delete(row.fieldApiName);
                                return next;
                              })
                            }
                            className="h-5 w-5 accent-primary"
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-2 font-semibold">
                              {row.label}
                              {row.classification === 'none' ? null : (
                                <span
                                  className={`inline-flex rounded-sm px-2 text-caption font-bold ${CLASSIFICATION_TONE[row.classification]}`}
                                >
                                  {t.t(`admin.fls.class.${row.classification}` as MessageId)}
                                </span>
                              )}
                            </span>
                            <span className="font-mono text-mono text-text-muted">
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
                            className={`border-s border-border p-2 ${changed ? 'bg-accent-soft' : ''}`}
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
                                className={`flex h-9 w-10 items-center justify-center rounded-md border disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                                  canRead(level)
                                    ? 'border-primary bg-primary-soft text-primary-text'
                                    : 'border-border bg-surface text-text-muted'
                                }`}
                              >
                                <Icon name="visibility" size="sm" />
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
                                className={`flex h-9 w-10 items-center justify-center rounded-md border disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                                  canEdit(level)
                                    ? 'border-primary bg-primary-soft text-primary-text'
                                    : 'border-border bg-surface text-text-muted'
                                }`}
                              >
                                <Icon name="edit_note" size="sm" />
                              </button>
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>

              {loadedMatrix.rows.length > 0 ? null : (
                <div
                  data-testid="fls-no-results"
                  className="flex flex-col items-center gap-3 p-12 text-center"
                >
                  <Icon name="search_off" size="xl" className="text-text-muted" />
                  <b className="text-body-lg">{t.t('admin.fls.noResults')}</b>
                  <button
                    type="button"
                    data-testid="fls-clear-search"
                    onClick={() => {
                      setQuery('');
                      setSensitiveOnly(false);
                    }}
                    className={SECONDARY_BUTTON}
                  >
                    {t.t('admin.fls.clearSearch')}
                  </button>
                </div>
              )}
            </div>
          )}
        </Panel>

        <p data-testid="fls-footer" className="text-body-sm text-text-muted">
          {t.t('admin.fls.footer', {
            shown: rows.length,
            total: data?.totalFieldCount ?? rows.length,
          })}
        </p>

        {saveError === null ? null : (
          <p
            role="alert"
            data-testid="fls-save-error"
            data-error-code={saveError.code}
            className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            {t.t(errorMessageId(saveError))}
          </p>
        )}

        {toast === null ? null : (
          <p
            role="status"
            data-testid="fls-toast"
            className="rounded-md bg-success-soft p-3 text-body-sm text-success-text"
          >
            {toast}
          </p>
        )}
      </div>

      {changes.length === 0 ? null : (
        <div
          data-testid="unsaved-bar"
          className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-border bg-inverse p-4 text-on-inverse"
        >
          <Icon name="edit_note" className="text-accent" />
          <b data-testid="unsaved-count" className="flex-1 text-body-sm">
            {t.t('admin.fls.unsaved', { count: changes.length })}
          </b>
          <button
            type="button"
            data-testid="discard-changes"
            onClick={() => {
              setDraft(new Map());
              setToast(t.t('admin.unsaved.discarded'));
            }}
            className={`${SECONDARY_BUTTON} border-border-strong bg-transparent text-on-inverse`}
          >
            {t.t('admin.unsaved.discard')}
          </button>
          <button
            type="button"
            data-testid="save-changes"
            disabled={saving}
            onClick={() => void save()}
            className="flex min-h-touch items-center justify-center rounded-md bg-accent px-4 text-body-md font-bold text-on-accent disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {saving ? t.t('admin.unsaved.saving') : t.t('admin.unsaved.save')}
          </button>
        </div>
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
              <button
                type="button"
                data-testid="leave-cancel"
                onClick={() => setPendingHref(null)}
                className={SECONDARY_BUTTON}
              >
                {t.t('admin.leave.cancel')}
              </button>
              <button
                type="button"
                data-testid="leave-confirm"
                onClick={() => {
                  const destination = pendingHref;
                  setPendingHref(null);
                  setDraft(new Map());
                  router.push(destination);
                }}
                className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary hover:bg-danger-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t.t('admin.leave.confirm')}
              </button>
            </>
          }
        >
          <p className="rounded-md bg-surface-sunken p-3 text-body-sm">
            {t.t('admin.fls.unsaved', { count: changes.length })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}
