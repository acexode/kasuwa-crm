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
import { AdminButton, CARD, Notice, PageHeader, UnsavedBar } from './admin-ui';
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
  bell,
  placeholders,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  linkedSettings: Readonly<Record<string, string>>;
  bell: boolean;
  /** `admin_placeholders` (D-L194): the role panel's View people, drawn disabled. */
  placeholders: boolean;
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

  const deleteCount = items.find((role) => role.id === deleteTarget)?.userCount ?? 0;

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="roles"
    >
      <div data-screen="P02/C" className="flex flex-col gap-6 pb-24">
        <PageHeader
          eyebrow={t.t('admin.roles.eyebrow')}
          title={t.t('admin.roles.title')}
          intro={t.t('admin.roles.intro')}
          actions={
            <>
              <AdminButton
                data-testid="expand-all"
                icon="unfold_more"
                disabled={items.length === 0}
                onClick={() => setCollapsed(new Set())}
              >
                {t.t('admin.roles.expandAll')}
              </AdminButton>
              <AdminButton
                data-testid="collapse-all"
                icon="unfold_less"
                disabled={items.length === 0}
                onClick={() => setCollapsed(new Set(items.map((role) => role.id)))}
              >
                {t.t('admin.roles.collapseAll')}
              </AdminButton>
              {/* `POST /roles` is not built. A control that looks live and
                  answers 501 is worse than one that is visibly not ready. */}
              <AdminButton variant="primary" icon="add" notReady data-testid="add-role">
                {t.t('admin.roles.add')}
              </AdminButton>
            </>
          }
        />

        <Panel t={t} resource={roles} skeletonRows={8}>
          {(data) =>
            data.items.length === 0 ? (
              <div
                data-testid="roles-empty"
                className={`${CARD} flex flex-col items-center gap-3.5 px-6 py-16 text-center`}
              >
                <span className="flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
                  <Icon name="account_tree" size={32} />
                </span>
                <h2 className="m-0 text-h4 font-bold">{t.t('admin.roles.empty.title')}</h2>
                <p className="m-0 max-w-lg text-pretty text-label font-normal text-text-2">
                  {t.t('admin.roles.empty.body')}
                </p>
                <AdminButton variant="primary" icon="add" notReady>
                  {t.t('admin.roles.add')}
                </AdminButton>
              </div>
            ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_380px]">
              <section
                aria-label={t.t('admin.roles.tree')}
                className={`${CARD} min-w-0 overflow-hidden`}
              >
                <p className="m-0 flex items-center gap-2 border-b border-border bg-surface-sunken px-4 py-3 text-meta text-text-2">
                  <Icon name="drag_pan" size={18} className="shrink-0" />
                  {t.t('admin.roles.dragHint')}
                </p>
                <div role="tree" aria-label={t.t('admin.roles.tree')} className="flex flex-col gap-0.5 p-2">
                  {rows.map((row) => {
                    const isSelected = row.role.id === selectedId;
                    return (
                    <div
                      key={row.role.id}
                      role="treeitem"
                      aria-level={row.level}
                      aria-selected={isSelected}
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
                      // The design's indent: 28px a level, from a 12px start.
                      style={{ paddingInlineStart: `${12 + (row.level - 1) * 28}px` }}
                      className={`flex min-h-touch cursor-grab select-none items-center gap-1.5 rounded-md pe-3 outline-none is-focus-visible:ring-focus ${
                        row.role.id === overId
                          ? 'bg-primary-soft'
                          : isSelected
                            ? 'bg-surface-sunken'
                            : 'is-hover:bg-surface-sunken'
                      } ${row.role.id === draggingId ? 'opacity-60' : ''}`}
                    >
                      <Icon name="drag_indicator" size={18} className="text-text-muted" />
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
                          className="flex size-7 shrink-0 items-center justify-center rounded-6 text-text-2 outline-none is-hover:bg-border is-focus-visible:ring-focus"
                        >
                          <Icon
                            name={collapsed.has(row.role.id) ? 'chevron_right' : 'expand_more'}
                            size={20}
                            className={collapsed.has(row.role.id) ? 'rtl:-scale-x-100' : ''}
                          />
                        </button>
                      ) : (
                        <span className="size-7 shrink-0" aria-hidden="true" />
                      )}
                      <span
                        aria-hidden="true"
                        className={`flex size-7 shrink-0 items-center justify-center rounded-6 ${
                          isSelected ? 'bg-primary text-on-primary' : 'bg-surface-sunken text-text-2'
                        }`}
                      >
                        <Icon name={row.hasChildren ? 'account_tree' : 'badge'} size={18} />
                      </span>
                      <span
                        className={`min-w-0 flex-1 truncate text-body-sm ${isSelected ? 'font-bold' : 'font-medium'}`}
                      >
                        {row.role.name}
                      </span>
                      {row.role.id === overId ? (
                        <span className="inline-flex h-5.5 items-center gap-1 rounded-full bg-primary px-2 text-caption font-bold text-on-primary">
                          <Icon name="arrow_forward" size={16} className="rtl:-scale-x-100" />
                          {t.t('admin.roles.moveUnder')}
                        </span>
                      ) : null}
                      {row.moved ? (
                        <span
                          data-testid="role-moved"
                          className="inline-flex h-5.5 items-center rounded-full bg-accent-soft px-2 text-caption font-bold text-accent-text"
                        >
                          {t.t('admin.roles.moved')}
                        </span>
                      ) : null}
                      <span className="inline-flex min-w-11 items-center justify-end gap-1 text-meta text-text-muted">
                        <Icon name="person" size={16} />
                        {formatCount(locale, row.role.userCount)}
                      </span>
                    </div>
                    );
                  })}

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
                      className="mt-2 flex min-h-touch items-center justify-center gap-2 rounded-md border-2 border-dashed border-border-strong text-meta font-semibold text-text-2"
                    >
                      <Icon name="vertical_align_top" size={18} />
                      {t.t('admin.roles.rootDrop')}
                    </div>
                  )}
                </div>
              </section>

              {selected === null ? null : (
                <aside
                  aria-label={t.t('admin.roles.selected')}
                  data-testid="role-panel"
                  className={`${CARD} flex flex-col`}
                >
                  <div className="flex flex-col gap-1 border-b border-border px-5 py-4.5">
                    <span className="text-caption font-bold uppercase tracking-wider text-text-muted">
                      {t.t('admin.roles.selected')}
                    </span>
                    <h2 className="m-0 text-h5 font-bold">{selected.name}</h2>
                    <span className="text-meta text-text-2">
                      {t.t('admin.roles.inRole', { count: selected.userCount })}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 border-b border-border px-5 py-4">
                    <label htmlFor="reports-to" className="text-meta font-bold">
                      {t.t('admin.roles.reportsTo')}
                    </label>
                    <span className="relative flex">
                      <select
                        id="reports-to"
                        data-testid="reports-to"
                        value={parents.get(selected.id) ?? ''}
                        onChange={(event) =>
                          move(selected.id, event.target.value === '' ? null : event.target.value)
                        }
                        className="h-control-base w-full cursor-pointer appearance-none rounded-md border border-border-strong bg-surface pe-10 ps-3 text-body-sm font-semibold text-text is-focus:field-focus"
                      >
                        <option value="">{t.t('admin.roles.topLevel')}</option>
                        {moveTargets(items, parents, selected.id).map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                      <Icon
                        name="expand_more"
                        size={20}
                        className="pointer-events-none absolute end-2.5 top-3 text-text"
                      />
                    </span>
                    {moves.some((pending) => pending.roleId === selected.id) ? (
                      <p data-testid="role-was" className="m-0 flex items-center gap-1.5 text-meta text-accent-text">
                        <Icon name="undo" size={16} />
                        {t.t('admin.roles.was', { name: nameOf(selected.parentRoleId) })}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2 border-b border-border px-5 py-4">
                    <span className="text-meta font-bold">{t.t('admin.roles.sees')}</span>
                    {/* Loaded separately, and absent until it is known. An
                        empty list rendered while the read is in flight says
                        "this role sees nothing", which is a visibility claim. */}
                    {detail.data?.seesRecordsOwnedBy === undefined ? (
                      <p className="m-0 text-meta text-text-muted">{t.t('admin.loading')}</p>
                    ) : detail.data.seesRecordsOwnedBy.roleCount === 0 ? (
                      <p data-testid="sees-none" className="m-0 text-body-sm text-text-2">
                        {t.t('admin.roles.sees.none')}
                      </p>
                    ) : (
                      <>
                        <span data-testid="sees-summary" className="text-meta text-text-2">
                          {t.t('admin.roles.sees.summary', {
                            roles: detail.data.seesRecordsOwnedBy.roleCount,
                            users: detail.data.seesRecordsOwnedBy.userCount,
                          })}
                        </span>
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                          {detail.data.seesRecordsOwnedBy.sample.map((role) => (
                            <li key={role.id} className="flex items-center gap-1.5 text-body-sm">
                              <Icon
                                name="subdirectory_arrow_right"
                                size={16}
                                className="text-text-muted rtl:-scale-x-100"
                              />
                              {role.name}
                            </li>
                          ))}
                        </ul>
                        {detail.data.seesRecordsOwnedBy.roleCount >
                        detail.data.seesRecordsOwnedBy.sample.length ? (
                          <span className="text-meta text-text-muted">
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

                  <div className="flex flex-wrap gap-2 px-5 py-4">
                    {placeholders ? (
                      <AdminButton notReady className="flex-1">
                        {t.t('admin.roles.viewPeople')}
                      </AdminButton>
                    ) : null}
                    <AdminButton
                      variant="danger-outline"
                      icon="delete"
                      data-testid="delete-role"
                      onClick={() => {
                        setSaveError(null);
                        setReassignTo(moveTargets(items, parents, selected.id)[0]?.id ?? '');
                        setDeleteTarget(selected.id);
                      }}
                    >
                      {t.t('admin.roles.delete')}
                    </AdminButton>
                  </div>
                </aside>
              )}
            </div>
            )
          }
        </Panel>

        {saveError === null ? null : (
          <Notice tone="danger" testId="roles-save-error" errorCode={saveError.code}>
            {t.t(errorMessageId(saveError))}
          </Notice>
        )}

        {toast === null ? null : (
          <Notice tone="success" testId="roles-toast">
            {toast}
          </Notice>
        )}
      </div>

      {moves.length === 0 ? null : (
        <UnsavedBar
          label={t.t('admin.unsaved.region')}
          count={t.t('admin.unsaved.count', { count: moves.length })}
          detail={t.t('admin.roles.unsaved', { count: moves.length })}
          discardLabel={t.t('admin.unsaved.discard')}
          saveLabel={t.t('admin.unsaved.save')}
          savingLabel={t.t('admin.unsaved.saving')}
          saving={saving}
          onDiscard={() => {
            setMoves([]);
            setSaveError(null);
            setToast(t.t('admin.unsaved.discarded'));
          }}
          onSave={() => void save()}
        />
      )}

      {deleteTarget === null ? null : (
        <Dialog
          title={t.t('admin.roles.delete.title', { name: nameOf(deleteTarget) })}
          body={`${t.t('admin.roles.delete.people', { count: deleteCount })} ${t.t('admin.roles.delete.body')}`}
          icon="delete"
          tone="danger"
          testId="delete-role-dialog"
          closeLabel={t.t('admin.dialog.close')}
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <AdminButton data-testid="delete-role-cancel" onClick={() => setDeleteTarget(null)}>
                {t.t('admin.roles.delete.cancel')}
              </AdminButton>
              <AdminButton
                variant="danger"
                data-testid="delete-role-confirm"
                disabled={saving || reassignTo === ''}
                onClick={() => void confirmDelete()}
              >
                {t.t('admin.roles.delete.confirm')}
              </AdminButton>
            </>
          }
        >
          {/* `reassignUsersToRoleId` is required even for an empty role, so the
              choice is always here — a role that gained a member between the
              page load and this click would otherwise orphan them. */}
          <div
            role="radiogroup"
            aria-labelledby="reassign-to-label"
            data-testid="reassign-to"
            className="flex flex-col gap-1.5"
          >
            <span id="reassign-to-label" className="text-meta font-bold">
              {t.t('admin.roles.delete.moveTo')}
            </span>
            {moveTargets(items, parents, deleteTarget).map((role) => {
              const checked = reassignTo === role.id;
              return (
                <button
                  key={role.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-value={role.id}
                  onClick={() => setReassignTo(role.id)}
                  className={`flex min-h-touch items-center gap-2.5 rounded-md border px-3 text-start text-body-sm text-text outline-none is-focus-visible:ring-focus ${
                    checked ? 'border-primary bg-primary-soft' : 'border-border bg-surface is-hover:bg-surface-sunken'
                  }`}
                >
                  <Icon
                    name={checked ? 'radio_button_checked' : 'radio_button_unchecked'}
                    size={20}
                    className={checked ? 'text-primary-text' : 'text-text-muted'}
                  />
                  {role.name}
                </button>
              );
            })}
          </div>
          {saveError === null ? null : (
            <p
              role="alert"
              data-testid="delete-role-error"
              data-error-code={saveError.code}
              className="m-0 rounded-10 bg-danger-soft px-3.5 py-3 text-meta text-danger-text"
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
              <AdminButton data-testid="leave-cancel" onClick={() => setPendingHref(null)}>
                {t.t('admin.leave.cancel')}
              </AdminButton>
              <AdminButton
                variant="danger"
                data-testid="leave-confirm"
                onClick={() => {
                  const destination = pendingHref;
                  setPendingHref(null);
                  setMoves([]);
                  router.push(destination);
                }}
              >
                {t.t('admin.leave.confirm')}
              </AdminButton>
            </>
          }
        >
          <p className="m-0 rounded-10 bg-surface-sunken px-3.5 py-3 text-meta">
            {t.t('admin.roles.unsaved', { count: moves.length })}
          </p>
        </Dialog>
      )}
    </AdminShell>
  );
}
