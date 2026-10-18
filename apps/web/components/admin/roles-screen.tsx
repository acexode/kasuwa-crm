'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import { useUnsavedGuard } from './use-unsaved-guard';
import { applyMove, canMove, moveTargets, parentMap, treeRows } from './role-tree';
import type { LanguageOption } from '../auth/language-menu';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import {
  deleteRole,
  getRole,
  listRoles,
  saveRoleHierarchy,
  type RoleMove,
  type ScreenError,
} from '../../lib/admin-api';
import { formatCount } from '../../lib/admin-format';

/**
 * `P02/C`, `C1`, `C2`, `C3` — the role hierarchy.
 *
 * ---------------------------------------------------------------------------
 * DRAGGING IS THE SHORTCUT. THE PICKER IS THE CONTROL.
 *
 * The design offers both and says so in its own hint text: "Drag a role onto
 * another to change who it reports to. Or pick 'Reports to' in the side
 * panel." That is not redundancy. HTML5 drag-and-drop is unreachable by
 * keyboard, unreliable under a screen reader, and on the mid-range Android
 * phone this console is actually used on it competes with scrolling. So the
 * "Reports to" listbox is the complete, keyboard-operable path and dragging is
 * an enhancement on top of it — never the only way to do something.
 *
 * MOVES BATCH, AND THE SAVE IS ONE REQUEST. The contract requires it: applying
 * moves one at a time passes through intermediate shapes that are cycles, and
 * a failure halfway leaves a hierarchy nobody designed. A `409` applies
 * nothing — not the valid moves either — and this screen says so rather than
 * leaving an admin to guess which half landed.
 *
 * CHANGING THIS HIERARCHY CHANGES WHO CAN SEE WHOSE RECORDS. That is why every
 * pending move is visible as "Moved", counted in the bar, and confirmable
 * before it is sent, instead of a drag that takes effect on drop.
 * ---------------------------------------------------------------------------
 */

export function RolesScreen({
  locale,
  messages,
  locales,
  linkedSettings,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
}) {
  const t = createBundleTranslator(locale, messages);
  const router = useRouter();

  const roles = useResource((signal) => listRoles(signal), []);

  const [moves, setMoves] = useState<readonly RoleMove[]>([]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScreenError | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState<string>('');
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const items = roles.data?.items ?? [];
  const parents = useMemo(() => parentMap(items, moves), [items, moves]);
  const rows = useMemo(() => treeRows(items, moves, collapsed), [items, moves, collapsed]);

  const onIntercept = useCallback((destination: string) => setPendingHref(destination), []);
  useUnsavedGuard(moves.length > 0, onIntercept);

  const selected = items.find((role) => role.id === selectedId) ?? null;

  // The side panel's "Can see records owned by" is a SEPARATE read, because
  // `descendantUserCount` and the sample of descendant names are computed by
  // the server for exactly the reason the list endpoint will not inline them:
  // visibility follows this relation and there must be one implementation.
  const detail = useResource(
    useCallback(
      (signal: AbortSignal) =>
        selectedId === null
          ? Promise.resolve({ ok: false as const, error: { code: 'not_found' as const } })
          : getRole(selectedId, signal),
      [selectedId],
    ),
    [selectedId],
  );

  const move = (roleId: string, newParentId: string | null) => {
    if (!canMove(parents, roleId, newParentId)) return;
    setMoves((current) => applyMove(items, current, roleId, newParentId));
  };

  const toggleCollapse = (roleId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });

  const save = async () => {
    if (roles.data === null || moves.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const result = await saveRoleHierarchy({ version: roles.data.version, moves });
    setSaving(false);
    if (result.ok) {
      setMoves([]);
      setToast(t.t('admin.roles.saved'));
      roles.reload();
      return;
    }
    setSaveError(result.error);
    // A stale version is not a retry. Re-read so the admin sees the hierarchy
    // their colleague saved before deciding what to do with their own moves.
    if (result.error.code === 'stale_write') roles.reload();
  };

  const confirmDelete = async () => {
    if (deleteTarget === null || reassignTo === '') return;
    setSaving(true);
    setSaveError(null);
    const name = items.find((role) => role.id === deleteTarget)?.name ?? '';
    const result = await deleteRole(deleteTarget, reassignTo);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    setDeleteTarget(null);
    setSelectedId(null);
    setToast(t.t('admin.roles.deleted', { name }));
    roles.reload();
  };

  const nameOf = (roleId: string | null) =>
    roleId === null
      ? t.t('admin.roles.topLevel')
      : (items.find((role) => role.id === roleId)?.name ?? t.t('admin.prog.unknown'));

  return (
    <AdminShell locale={locale} messages={messages} locales={locales} linkedSettings={linkedSettings} activeSettingId="roles">
      <div data-screen="P02/C" className="flex flex-col gap-6 pb-24">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-body-sm font-semibold text-text-muted">
              {t.t('admin.roles.eyebrow')}
            </span>
            <h1 className="text-h2">{t.t('admin.roles.title')}</h1>
            <p className="max-w-prose text-body-md text-text-2">{t.t('admin.roles.intro')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="expand-all"
              onClick={() => setCollapsed(new Set())}
              className={SECONDARY_BUTTON}
            >
              <Icon name="unfold_more" size="sm" />
              {t.t('admin.roles.expandAll')}
            </button>
            <button
              type="button"
              data-testid="collapse-all"
              onClick={() => setCollapsed(new Set(items.map((role) => role.id)))}
              className={SECONDARY_BUTTON}
            >
              <Icon name="unfold_less" size="sm" />
              {t.t('admin.roles.collapseAll')}
            </button>
            {/* `POST /roles` is not built. A control that looks live and
                answers 501 is worse than one that is visibly not ready. */}
            <span
              className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`}
              aria-disabled
              data-testid="add-role"
            >
              <Icon name="add" size="sm" />
              {t.t('admin.roles.add')}
            </span>
          </div>
        </div>

        <Panel t={t} resource={roles} skeletonRows={8}>
          {() => (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section
                aria-label={t.t('admin.roles.tree')}
                className="overflow-hidden rounded-lg border border-border bg-surface"
              >
                <p className="flex items-center gap-2 border-b border-border bg-surface-sunken p-3 text-body-sm text-text-2">
                  <Icon name="drag_pan" size="sm" />
                  {t.t('admin.roles.dragHint')}
                </p>
                <div role="tree" aria-label={t.t('admin.roles.tree')} className="flex flex-col p-2">
                  {rows.map((row) => (
                    <div
                      key={row.role.id}
                      role="treeitem"
                      aria-level={row.level}
                      aria-selected={row.role.id === selectedId}
                      {...(row.hasChildren
                        ? { 'aria-expanded': !collapsed.has(row.role.id) }
                        : {})}
                      tabIndex={0}
                      draggable
                      data-testid="role-node"
                      data-role-id={row.role.id}
                      data-moved={row.moved}
                      onClick={() => setSelectedId(row.role.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(row.role.id);
                        }
                      }}
                      onDragStart={() => setDraggingId(row.role.id)}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setOverId(null);
                      }}
                      onDragOver={(event) => {
                        if (draggingId === null) return;
                        if (!canMove(parents, draggingId, row.role.id)) return;
                        event.preventDefault();
                        setOverId(row.role.id);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggingId !== null) move(draggingId, row.role.id);
                        setDraggingId(null);
                        setOverId(null);
                      }}
                      style={{ paddingInlineStart: `${row.level * 12}px` }}
                      className={`flex min-h-touch cursor-grab select-none items-center gap-2 rounded-md px-3 ${
                        row.role.id === overId
                          ? 'bg-primary-soft'
                          : row.role.id === selectedId
                            ? 'bg-surface-sunken'
                            : ''
                      } ${row.role.id === draggingId ? 'opacity-60' : ''} hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus`}
                    >
                      <Icon name="drag_indicator" size="sm" className="text-text-muted" />
                      {row.hasChildren ? (
                        <button
                          type="button"
                          data-testid="role-toggle"
                          aria-label={t.t(
                            collapsed.has(row.role.id)
                              ? 'admin.roles.expand'
                              : 'admin.roles.collapse',
                            { name: row.role.name },
                          )}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleCollapse(row.role.id);
                          }}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          <Icon
                            name={collapsed.has(row.role.id) ? 'chevron_right' : 'expand_more'}
                            size="sm"
                          />
                        </button>
                      ) : (
                        <span className="h-8 w-8 shrink-0" aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-body-md font-semibold">
                        {row.role.name}
                      </span>
                      {row.role.id === overId ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 text-caption font-bold text-on-primary">
                          <Icon name="arrow_forward" size="sm" />
                          {t.t('admin.roles.moveUnder')}
                        </span>
                      ) : null}
                      {row.moved ? (
                        <span
                          data-testid="role-moved"
                          className="inline-flex items-center rounded-full bg-accent-soft px-2 text-caption font-bold text-accent-text"
                        >
                          {t.t('admin.roles.moved')}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1 text-body-sm text-text-muted">
                        <Icon name="person" size="sm" />
                        {formatCount(locale, row.role.userCount)}
                      </span>
                    </div>
                  ))}

                  {draggingId === null ? null : (
                    <div
                      data-testid="root-drop"
                      onDragOver={(event) => {
                        if (draggingId !== null && canMove(parents, draggingId, null)) {
                          event.preventDefault();
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggingId !== null) move(draggingId, null);
                        setDraggingId(null);
                        setOverId(null);
                      }}
                      className="mt-2 flex min-h-touch items-center justify-center gap-2 rounded-md border-2 border-dashed border-border-strong text-body-sm font-semibold text-text-2"
                    >
                      <Icon name="vertical_align_top" size="sm" />
                      {t.t('admin.roles.rootDrop')}
                    </div>
                  )}
                </div>
              </section>

              {selected === null ? null : (
                <aside
                  aria-label={t.t('admin.roles.selected')}
                  data-testid="role-panel"
                  className="flex flex-col rounded-lg border border-border bg-surface"
                >
                  <div className="flex flex-col gap-1 border-b border-border p-5">
                    <span className="text-caption font-bold uppercase text-text-muted">
                      {t.t('admin.roles.selected')}
                    </span>
                    <h2 className="text-h4">{selected.name}</h2>
                    <span className="text-body-sm text-text-2">
                      {t.t('admin.roles.inRole', { count: selected.userCount })}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 border-b border-border p-5">
                    <label
                      htmlFor="reports-to"
                      className="text-body-sm font-bold"
                    >
                      {t.t('admin.roles.reportsTo')}
                    </label>
                    <select
                      id="reports-to"
                      data-testid="reports-to"
                      value={parents.get(selected.id) ?? ''}
                      onChange={(event) =>
                        move(selected.id, event.target.value === '' ? null : event.target.value)
                      }
                      className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      <option value="">{t.t('admin.roles.topLevel')}</option>
                      {moveTargets(items, parents, selected.id).map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    {moves.some((pending) => pending.roleId === selected.id) ? (
                      <p data-testid="role-was" className="text-body-sm text-accent-text">
                        {t.t('admin.roles.was', { name: nameOf(selected.parentRoleId) })}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2 border-b border-border p-5">
                    <span className="text-body-sm font-bold">{t.t('admin.roles.sees')}</span>
                    {/* Loaded separately, and absent until it is known. An
                        empty list rendered while the read is in flight says
                        "this role sees nothing", which is a visibility claim. */}
                    {detail.data?.seesRecordsOwnedBy === undefined ? (
                      <p className="text-body-sm text-text-muted">{t.t('admin.loading')}</p>
                    ) : detail.data.seesRecordsOwnedBy.roleCount === 0 ? (
                      <p data-testid="sees-none" className="text-body-sm text-text-2">
                        {t.t('admin.roles.sees.none')}
                      </p>
                    ) : (
                      <>
                        <span data-testid="sees-summary" className="text-body-sm text-text-2">
                          {t.t('admin.roles.sees.summary', {
                            roles: detail.data.seesRecordsOwnedBy.roleCount,
                            users: detail.data.seesRecordsOwnedBy.userCount,
                          })}
                        </span>
                        <ul className="flex flex-col gap-1">
                          {detail.data.seesRecordsOwnedBy.sample.map((role) => (
                            <li key={role.id} className="flex items-center gap-2 text-body-md">
                              <Icon name="subdirectory_arrow_right" size="sm" className="text-text-muted" />
                              {role.name}
                            </li>
                          ))}
                        </ul>
                        {detail.data.seesRecordsOwnedBy.roleCount >
                        detail.data.seesRecordsOwnedBy.sample.length ? (
                          <span className="text-body-sm text-text-muted">
                            {t.t('admin.roles.sees.more', {
                              count:
                                detail.data.seesRecordsOwnedBy.roleCount -
                                detail.data.seesRecordsOwnedBy.sample.length,
                            })}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 p-5">
                    <button
                      type="button"
                      data-testid="delete-role"
                      onClick={() => {
                        setSaveError(null);
                        setReassignTo(
                          moveTargets(items, parents, selected.id)[0]?.id ?? '',
                        );
                        setDeleteTarget(selected.id);
                      }}
                      className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-danger bg-surface px-4 text-body-md font-semibold text-danger-text hover:bg-danger-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      <Icon name="delete" size="sm" />
                      {t.t('admin.roles.delete')}
                    </button>
                  </div>
                </aside>
              )}
            </div>
          )}
        </Panel>

        {saveError === null ? null : (
          <p
            role="alert"
            data-testid="roles-save-error"
            data-error-code={saveError.code}
            className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            {t.t(errorMessageId(saveError))}
          </p>
        )}

        {toast === null ? null : (
          <p
            role="status"
            data-testid="roles-toast"
            className="rounded-md bg-success-soft p-3 text-body-sm text-success-text"
          >
            {toast}
          </p>
        )}
      </div>

      {moves.length === 0 ? null : (
        <div
          data-testid="unsaved-bar"
          className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-border bg-inverse p-4 text-on-inverse"
        >
          <Icon name="edit_note" className="text-accent" />
          <b data-testid="unsaved-count" className="flex-1 text-body-sm">
            {t.t('admin.roles.unsaved', { count: moves.length })}
          </b>
          <button
            type="button"
            data-testid="discard-changes"
            onClick={() => {
              setMoves([]);
              setSaveError(null);
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

      {deleteTarget === null ? null : (
        <Dialog
          title={t.t('admin.roles.delete.title', { name: nameOf(deleteTarget) })}
          body={t.t('admin.roles.delete.body')}
          icon="delete"
          tone="danger"
          testId="delete-role-dialog"
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                data-testid="delete-role-cancel"
                onClick={() => setDeleteTarget(null)}
                className={SECONDARY_BUTTON}
              >
                {t.t('admin.roles.delete.cancel')}
              </button>
              <button
                type="button"
                data-testid="delete-role-confirm"
                disabled={saving || reassignTo === ''}
                onClick={() => void confirmDelete()}
                className="flex min-h-touch items-center justify-center rounded-md bg-danger px-4 text-body-md font-bold text-on-primary disabled:opacity-60 hover:bg-danger-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t.t('admin.roles.delete.confirm')}
              </button>
            </>
          }
        >
          {/* `reassignUsersToRoleId` is required even for an empty role, so the
              picker is always here — a role that gained a member between the
              page load and this click would otherwise orphan them. */}
          <p className="text-body-sm">
            {t.t('admin.roles.delete.people', {
              count: items.find((role) => role.id === deleteTarget)?.userCount ?? 0,
            })}
          </p>
          <label htmlFor="reassign-to" className="text-body-sm font-bold">
            {t.t('admin.roles.delete.moveTo')}
          </label>
          <select
            id="reassign-to"
            data-testid="reassign-to"
            value={reassignTo}
            onChange={(event) => setReassignTo(event.target.value)}
            className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {moveTargets(items, parents, deleteTarget).map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          {saveError === null ? null : (
            <p
              role="alert"
              data-testid="delete-role-error"
              data-error-code={saveError.code}
              className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
            >
              {t.t(errorMessageId(saveError))}
            </p>
          )}
        </Dialog>
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
                  setMoves([]);
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
            {t.t('admin.roles.unsaved', { count: moves.length })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}
