'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Drawer } from '@kasuwa/ui/components';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../../icon';
import { useMayInTenant } from '../../../lib/use-capabilities';
import { formatCount } from '../../../lib/admin-format';
import { fullState } from '../../../lib/custom-field-model';
import {
  listCustomFields,
  type CustomFieldDefinition,
  type CustomFieldObject,
  type CustomFieldType,
} from '../../../lib/custom-fields-api';
import { ErrorPanel, Panel, StillConnecting } from '../panel';
import { useResource } from '../use-resource';
import { FieldForm, type FormFlags, type SavedKind } from './field-form';
import { RetireDialog } from './retire-dialog';
import { PROPERTY_CHIP, STUDIO_CHIP, STUDIO_INPUT, STUDIO_PRIMARY } from './studio-classes';
import { CLASSIFICATION_LABEL, TYPE_ICON, TYPE_LABEL, modifiedDate } from './studio-text';

/**
 * `P18/B` — one object's custom fields, drawn to the export's Fields tab
 * (T-0142): the limit banner, the toolbar (search, "Show retired", the limit
 * meter, New field), the field table, and the field editor beside it.
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
 *
 * THE EDITOR is docked beside the table from 1280 up, as the export draws it at
 * 1440 (the table narrows and loses its Modified column), and is the T-0129
 * drawer below that, over a scrim, as the export draws it at 1024.
 */

export type EditorFlags = FormFlags;

type FormState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly field: CustomFieldDefinition };

const STATUS: Readonly<Record<SavedKind | 'retired', MessageId>> = {
  created: 'admin.studio.custom.status.created',
  updated: 'admin.studio.custom.status.updated',
  retired: 'admin.studio.custom.status.wasRetired',
};

const DOCKED_QUERY = '(min-width: 1280px)';

function useDocked(): boolean {
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(DOCKED_QUERY);
    const update = () => setDocked(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return docked;
}

/**
 * The column grid, per state. Written out whole so Tailwind sees each one:
 * the export's `fieldCols`, plus a 44px column for the retire control.
 */
const COLUMNS = {
  // The export drops Modified below 1280 (its `wideF` is desktop only): narrow at md, wide from xl.
  wide: 'md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_104px_44px] xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1fr)_130px_120px_44px]',
  wideUsage: 'md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_104px_90px_44px] xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,1fr)_130px_110px_120px_44px]',
  narrow: 'md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_104px_44px]',
  narrowUsage: 'md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1fr)_104px_90px_44px]',
} as const;

function Meter({
  label,
  value,
  ratio,
  testId,
}: {
  label: string;
  value: string;
  /** Used over limit; null draws the empty bar. */
  ratio: number | null;
  testId?: string;
}) {
  const full = ratio !== null && ratio >= 1;
  const near = ratio !== null && ratio >= 0.85;
  return (
    <div data-testid={testId} className="flex min-w-32 flex-col gap-1">
      <span className="flex justify-between gap-2 text-caption font-normal text-text-2">
        <span>{label}</span>
        <b className={full ? 'text-danger-text' : 'text-text'}>{value}</b>
      </span>
      <span aria-hidden="true" className="relative block h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        {ratio === null ? null : (
          <span
            className={`absolute inset-y-0 start-0 rounded-full ${full ? 'bg-danger' : near ? 'bg-warning' : 'bg-primary'}`}
            style={{ inlineSize: `${Math.min(100, Math.round(ratio * 100))}%` }}
          />
        )}
      </span>
    </div>
  );
}

/**
 * The docked editor's column: sticky under the top bar, and exactly as tall
 * as the viewport below where it starts, so its footer is always in view.
 */
function DockedPanel({ children, onEscape }: { children: ReactNode; onEscape: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const node = ref.current;
      if (node === null) return;
      setHeight(Math.max(0, window.innerHeight - node.getBoundingClientRect().top));
    };
    measure();
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <section
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onEscape();
        }
      }}
      style={height === null ? undefined : { blockSize: `${height}px` }}
      className="sticky top-shell-header flex w-overlay-studio-panel shrink-0 flex-col border-s border-border bg-surface"
    >
      {children}
    </section>
  );
}

function EditorHeader({
  icon,
  title,
  subtitle,
  closeLabel,
  onClose,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border py-3.5 pe-4 ps-5">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-card-title">{title}</h2>
        <span className="truncate text-caption font-normal text-text-muted">{subtitle}</span>
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="flex size-touch items-center justify-center rounded-md text-text-2 outline-none is-hover:bg-surface-sunken focus-visible:ring-focus md:size-control-md"
      >
        <Icon name="close" size={22} />
      </button>
    </div>
  );
}

export function ObjectPanel({
  t,
  locale,
  object,
  flags,
  header,
  onFormState,
  onCount,
}: {
  t: Translator;
  locale: string;
  object: CustomFieldObject;
  flags: EditorFlags;
  /** The object header and its tabs, drawn above the toolbar. */
  header: ReactNode;
  /** Stable. What leaving would lose, and whether a write is in flight, for the screen's guards. */
  onFormState: (state: { dirty: boolean; saving: boolean }) => void;
  /** The active count, once read, for the Fields tab's badge. */
  onCount: (count: number) => void;
}) {
  const list = useResource((signal) => listCustomFields(object, signal), [object]);
  const docked = useDocked();
  // T-0158: left out only when the API said the caller lacks `custom_field.write`
  // (the tenant admin's alone). An unread answer draws them; the API's 403 is the gate.
  const mayWrite = useMayInTenant('custom_field.write');
  const [showRetired, setShowRetired] = useState(false);
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<FormState>({ kind: 'closed' });
  const [createType, setCreateType] = useState<CustomFieldType>('text');
  const [retiring, setRetiring] = useState<CustomFieldDefinition | null>(null);
  const [status, setStatus] = useState<MessageId | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const focusNewAfterRead = useRef(false);
  const onType = useCallback((type: CustomFieldType) => setCreateType(type), []);

  // After a retire the row that opened the dialog is gone: focus goes to the
  // create control once the list has been read, not to the top of the page.
  useEffect(() => {
    if (focusNewAfterRead.current && list.data !== null) {
      focusNewAfterRead.current = false;
      newButton.current?.focus();
    }
  }, [list.data]);

  useEffect(() => {
    if (list.data !== null) onCount(list.data.items.filter((item) => item.retiredAt === null).length);
  }, [list.data, onCount]);

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

  const askRetire = (item: CustomFieldDefinition, from: HTMLElement) => {
    opener.current = from;
    setRetiring(item);
  };

  const editing = form.kind === 'edit' ? form.field : null;
  const editorOpen = form.kind !== 'closed';
  const dockedOpen = editorOpen && docked;

  const editorTitle = editing === null ? t.t('admin.studio.editor.new') : editing.label;
  const editorSubtitle =
    editing === null ? (
      t.t(TYPE_LABEL[createType])
    ) : (
      <span dir="ltr" className="font-mono">
        {t.t('admin.studio.editor.subtitle', { apiName: editing.apiName, type: t.t(TYPE_LABEL[editing.type]) })}
      </span>
    );
  const editorIcon = (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-10 bg-primary-soft text-primary-text">
      <Icon name={editing === null ? 'add' : TYPE_ICON[editing.type]} size={22} />
    </span>
  );

  const editorForm = (data: { limits: Parameters<typeof FieldForm>[0]['limits'] }) =>
    form.kind === 'closed' ? null : (
      <FieldForm
        key={form.kind === 'edit' ? form.field.id : 'create'}
        t={t}
        locale={locale}
        mode={form.kind}
        object={object}
        {...(form.kind === 'edit' ? { field: form.field } : {})}
        limits={data.limits}
        flags={flags}
        onSaved={saved}
        onCancel={closeForm}
        onStale={list.reload}
        onState={onFormState}
        onType={onType}
        {...(form.kind === 'edit' ? { onRetire: (from: HTMLElement) => askRetire(form.field, from) } : {})}
      />
    );

  return (
    <div
      data-screen="P18/B"
      {...(dockedOpen ? { 'data-editor-docked': '' } : {})}
      className={dockedOpen ? 'flex items-start xl:-mb-10 xl:-me-8 xl:-mt-7' : ''}
    >
      <div className={`flex min-w-0 flex-1 flex-col gap-5 ${dockedOpen ? 'xl:pb-10 xl:pe-8 xl:pt-7' : ''}`}>
        {header}

        {/* With data in hand a slow or failed RELOAD is drawn beside it, never instead of it:
            swapping the panel out would unmount the open form and dialog under the admin's hands. */}
        <Panel t={t} resource={list.data === null ? list : { ...list, slow: false, error: null }}>
          {(data) => {
            const active = data.items.filter((item) => item.retiredAt === null);
            const state = fullState(data.items, data.limits);
            const full = state !== 'open';
            const needle = query.trim().toLocaleLowerCase(locale);
            const shown = (showRetired ? data.items : active).filter(
              (item) => needle === '' || `${item.label} ${item.apiName}`.toLocaleLowerCase(locale).includes(needle),
            );
            const columns = dockedOpen
              ? flags.usage
                ? COLUMNS.narrowUsage
                : COLUMNS.narrow
              : flags.usage
                ? COLUMNS.wideUsage
                : COLUMNS.wide;

            return (
              <>
                {list.slow ? <StillConnecting t={t} /> : null}
                {list.error === null ? null : <ErrorPanel t={t} error={list.error} onRetry={list.reload} />}

                {full ? (
                  <div role="note" data-testid="limit-note" className="flex flex-wrap items-start gap-x-3.5 gap-y-3 rounded-lg bg-warning-soft px-4 py-3.5 text-warning-text">
                    <Icon name="block" size={22} />
                    <div className="flex min-w-0 flex-1 basis-80 flex-col gap-0.5">
                      <b className="text-body-sm">{t.t('admin.studio.limit.title')}</b>
                      <span className="text-meta text-text">
                        {t.t(state === 'definitions' ? 'admin.studio.custom.limit.definitions' : 'admin.studio.custom.error.field_limit_reached')}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative min-w-44 flex-1 basis-44 sm:max-w-72">
                    <Icon name="search" size={20} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t.t('admin.studio.search')}
                      aria-label={t.t('admin.studio.search')}
                      className={`${STUDIO_INPUT} ps-9`}
                    />
                  </div>
                  {flags.usage ? (
                    <button type="button" disabled aria-pressed="false" className={`${STUDIO_CHIP} cursor-not-allowed border-border bg-surface text-disabled-text`}>
                      {t.t('admin.studio.usage.unusedChip')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="switch"
                    data-testid="show-retired"
                    aria-checked={showRetired}
                    onClick={() => setShowRetired((current) => !current)}
                    className={`${STUDIO_CHIP} ${showRetired ? 'border-primary bg-primary text-on-primary' : 'border-border bg-surface text-text is-hover:bg-surface-sunken'}`}
                  >
                    {showRetired ? <Icon name="check" size={18} /> : null}
                    {t.t('admin.studio.custom.showRetired')}
                    <span className="font-medium">{formatCount(locale, data.items.length - active.length)}</span>
                  </button>
                  <span className="hidden flex-1 md:block" />
                  <Meter
                    testId="field-limit"
                    label={t.t('admin.studio.meter.fields')}
                    value={t.t('admin.studio.meter.count', {
                      active: formatCount(locale, active.length),
                      limit: formatCount(locale, data.limits.fieldsPerObject),
                    })}
                    ratio={active.length / data.limits.fieldsPerObject}
                  />
                  {flags.usage ? <Meter label={t.t('admin.studio.meter.filterable')} value={t.t('admin.studio.meter.unknown')} ratio={null} /> : null}
                  {mayWrite ? (
                    <button
                      ref={newButton}
                      type="button"
                      data-testid="field-new"
                      disabled={full}
                      title={full ? t.t('admin.studio.limit.title') : undefined}
                      onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
                      className={STUDIO_PRIMARY}
                    >
                      <Icon name="add" size={20} />
                      {t.t('admin.studio.custom.new')}
                    </button>
                  ) : null}
                </div>

                <div role="status">
                  {status === null ? null : (
                    <p data-testid="studio-status" className="flex gap-2 rounded-10 bg-success-soft px-3.5 py-2.5 text-meta font-semibold text-success-text">
                      <Icon name="check_circle" size={18} />
                      {t.t(status)}
                    </p>
                  )}
                </div>

                {shown.length === 0 ? (
                  <div
                    data-testid="fields-empty"
                    className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-6 py-10 text-center"
                  >
                    <Icon name="dashboard_customize" size={32} className="text-text-muted" />
                    <b className="text-card-title">{t.t(needle === '' ? 'admin.studio.empty.title' : 'admin.studio.empty.noMatch')}</b>
                    {needle === '' ? <span className="max-w-overlay-dialog-form text-body-relaxed text-text-2">{t.t('admin.studio.custom.empty')}</span> : null}
                  </div>
                ) : (
                  <div role="table" aria-label={t.t('admin.studio.custom.title')} className="overflow-hidden rounded-lg border border-border bg-surface">
                    <div
                      role="row"
                      className={`hidden min-h-control-md items-center gap-3 border-b border-border bg-surface-sunken px-4 text-caption font-bold text-text-2 md:grid ${columns}`}
                    >
                      <span role="columnheader">{t.t('admin.studio.col.label')}</span>
                      <span role="columnheader">{t.t('admin.studio.col.apiName')}</span>
                      <span role="columnheader">{t.t('admin.studio.col.type')}</span>
                      <span role="columnheader">{t.t('admin.studio.col.properties')}</span>
                      {flags.usage ? <span role="columnheader">{t.t('admin.studio.col.usedIn')}</span> : null}
                      {dockedOpen ? null : (
                        <span role="columnheader" className="hidden xl:block">
                          {t.t('admin.studio.col.modified')}
                        </span>
                      )}
                      <span role="columnheader">
                        <span className="sr-only">{t.t('admin.studio.col.actions')}</span>
                      </span>
                    </div>
                    {shown.map((item) => {
                      const retired = item.retiredAt !== null;
                      const selected = editing?.id === item.id;
                      return (
                        <div
                          key={item.id}
                          role="row"
                          aria-selected={selected || undefined}
                          data-field-row={item.apiName}
                          data-type={item.type}
                          data-classification={item.classification}
                          data-retired={retired ? 'true' : 'false'}
                          onClick={(event) => {
                            // A press on a control in the row (or on the glyph inside one) is that control's own:
                            // the retire button must not also open the editor behind its dialog (T-0149).
                            if (retired || !mayWrite || (event.target instanceof Element && event.target.closest('button, a, input') !== null)) return;
                            const edit = event.currentTarget.querySelector<HTMLElement>('[data-testid="field-edit"]');
                            if (edit !== null) open({ kind: 'edit', field: item }, edit);
                          }}
                          className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-body-sm last:border-b-0 md:min-h-control-xl md:gap-y-0 md:py-1.5 ${columns} ${
                            selected ? 'bg-primary-soft' : retired ? 'bg-surface-sunken' : 'cursor-pointer is-hover:bg-surface-sunken'
                          }`}
                        >
                          <span role="cell" className="flex min-w-0 items-center gap-1.5 font-semibold">
                            {retired || !mayWrite ? (
                              <span data-record-text className="truncate text-text-2">
                                {item.label}
                              </span>
                            ) : (
                              <button
                                type="button"
                                data-testid="field-edit"
                                onClick={(event) => open({ kind: 'edit', field: item }, event.currentTarget)}
                                className="min-w-0 truncate rounded-sm text-start outline-none focus-visible:ring-focus"
                              >
                                <span className="sr-only">{t.t('admin.studio.custom.edit')} </span>
                                <span data-record-text>{item.label}</span>
                              </button>
                            )}
                            {item.description === null || item.description === '' ? null : (
                              <span className="flex shrink-0 text-text-muted">
                                {/* The tooltip is the tenant's own text, so it sits on the glyph only; assistive
                                    technology reads the same text once, marked as record data (T-0149). */}
                                <span aria-hidden="true" title={item.description} className="flex">
                                  <Icon name="help" size={16} />
                                </span>
                                <span data-record-text className="sr-only">
                                  {item.description}
                                </span>
                              </span>
                            )}
                          </span>
                          <span role="cell" data-record-text dir="ltr" className="col-start-1 truncate text-start font-mono text-caption font-normal text-text-2 md:col-start-auto">
                            {item.apiName}
                          </span>
                          <span role="cell" className="col-start-1 flex min-w-0 items-center gap-1.5 text-text-2 md:col-start-auto">
                            <Icon name={TYPE_ICON[item.type]} size={18} />
                            <span className="truncate">{t.t(TYPE_LABEL[item.type])}</span>
                          </span>
                          <span role="cell" className="col-start-1 flex flex-wrap items-center gap-1 md:col-start-auto">
                            {item.classification === 'none' ? null : (
                              <span title={t.t(CLASSIFICATION_LABEL[item.classification])} className={PROPERTY_CHIP}>
                                <Icon name="lock" size={15} />
                                <span className="sr-only">{t.t(CLASSIFICATION_LABEL[item.classification])}</span>
                              </span>
                            )}
                            {retired ? (
                              <span className="inline-flex h-5.5 items-center rounded-full bg-danger-soft px-2 text-caption font-bold text-danger-text">
                                {t.t('admin.studio.custom.retired')}
                              </span>
                            ) : null}
                          </span>
                          {flags.usage ? (
                            <span role="cell" className="hidden text-meta text-text-muted md:block">
                              {t.t('admin.studio.meter.unknown')}
                            </span>
                          ) : null}
                          {dockedOpen ? null : (
                            <span role="cell" className="hidden text-meta text-text-muted xl:block">
                              <time dateTime={item.updatedAt}>{modifiedDate(locale, item.updatedAt)}</time>
                            </span>
                          )}
                          <span role="cell" className="col-start-2 row-start-1 flex justify-end md:col-start-auto md:row-start-auto">
                            {retired || !mayWrite ? null : (
                              <button
                                type="button"
                                data-testid="field-retire"
                                title={t.t('admin.studio.custom.retire')}
                                onClick={(event) => askRetire(item, event.currentTarget)}
                                className="flex size-touch items-center justify-center rounded-md text-text-muted outline-none is-hover:bg-surface focus-visible:ring-focus md:size-control-sm"
                              >
                                <Icon name="archive" size={18} />
                                <span className="sr-only">
                                  {t.t('admin.studio.custom.retire')} <span data-record-text>{item.label}</span>
                                </span>
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {editorOpen && !docked ? (
                  <Drawer
                    open
                    size="studio"
                    flush
                    leading={editorIcon}
                    title={editorTitle}
                    subtitle={editorSubtitle}
                    closeLabel={t.t('admin.studio.editor.closeLabel')}
                    onClose={closeForm}
                  >
                    {editorForm(data)}
                  </Drawer>
                ) : null}

                {retiring === null ? null : (
                  <RetireDialog
                    t={t}
                    field={retiring}
                    onClose={() => setRetiring(null)}
                    onStale={list.reload}
                    onRetired={() => {
                      setRetiring(null);
                      setForm({ kind: 'closed' });
                      setStatus(STATUS.retired);
                      focusNewAfterRead.current = true;
                      list.reload();
                    }}
                  />
                )}
              </>
            );
          }}
        </Panel>
      </div>

      {dockedOpen && list.data !== null ? (
        <DockedPanel onEscape={closeForm}>
          <EditorHeader
            icon={editorIcon}
            title={editorTitle}
            subtitle={editorSubtitle}
            closeLabel={t.t('admin.studio.editor.closeLabel')}
            onClose={closeForm}
          />
          {editorForm(list.data)}
        </DockedPanel>
      ) : null}
    </div>
  );
}
