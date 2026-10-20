'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import type { LanguageOption } from '../auth/language-menu';
import { Pill, Switch, initials } from '@kasuwa/ui/components';
import { AdminButton, CARD, PageHeader, ROW_ICON_BUTTON, TABLE_HEAD, TEXT_ACTION } from './admin-ui';
import {
  createAuditExport,
  getAuditFilterOptions,
  listAuditEvents,
  type AuditAction,
  type AuditQuery,
  type ScreenError,
} from '../../lib/admin-api';
import {
  AUDIT_RANGES,
  activeFilterCount,
  auditActionTone,
  humaniseKey,
  isLabelledObjectType,
  rangeToFrom,
  withheldIfIdentifier,
  type AuditRangeKey,
} from '../../lib/admin-audit';
import { formatStamp, formatZone, looksLikeId } from '../../lib/admin-format';

/**
 * `P02/E`, `P02/E1`, `P02/E2` — the audit log.
 *
 * Read-only, and there is no store behind it yet: `T-0001` left the write side
 * out and it is still out. Both halves are one task, because an audit log with
 * a reader and no writer is a screen that says "no events match" forever.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PII RULES, AND WHY EACH IS DRAWN THE WAY IT IS
 *
 * 1. `sourceIp` is null unless the caller's permissions allow it, and null
 *    means "not shown to YOU" — never "none was recorded". The screen renders
 *    ONE thing for both, with no tooltip, no dash-versus-blank distinction and
 *    no title attribute that differs. If the two were distinguishable the
 *    field would become an oracle for what the log holds about an address the
 *    caller is not allowed to read.
 *
 * 2. `AuditChange.redacted` renders THAT a sensitive field changed, and not
 *    what it changed to. A diff that helpfully showed the old and new value of
 *    a customer's phone number would put personal data into an export an admin
 *    can email to themselves.
 *
 * 3. `objectLabel` is a display name and never an email address. That is the
 *    server's job; `withheldIfIdentifier` is this screen's second layer, and
 *    it withholds VISIBLY so the defect is reportable rather than invisible.
 *    The design's "Invited · fatima.bello@…" row is exactly the thing the
 *    contract rules out — an address is a credential-adjacent identifier and
 *    this screen is one of the most broadly readable in the console.
 * ---------------------------------------------------------------------------
 *
 * Filters NARROW what you can already see. They never widen it: the reachable
 * set is resolved from `user_programme`, and filtering by an actor you cannot
 * see returns the same empty page as an actor who did nothing. That ambiguity
 * is deliberate and the chips exist so the empty page is still attributable to
 * what you asked for.
 */

const PAGE_SIZE = 25;

export function AuditScreen({
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

  /**
   * The column is headed with the NAME of the zone it is rendered in, because
   * a BPO roster spans WAT, EAT and SAST and "14:32" with no zone is a time
   * somebody will act on in the wrong hour.
   *
   * It is resolved after mount, not during render: the server's zone is not
   * the reader's, and rendering one then replacing it with the other is a
   * hydration mismatch that React resolves by keeping the WRONG one. Until it
   * is known the header says "Time" and no zone is claimed — which is the same
   * rule as everywhere else in this console, that an unknown never renders as
   * a value.
   */
  const [zone, setZone] = useState('unknown');
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [objectType, setObjectType] = useState('');
  const [range, setRange] = useState<AuditRangeKey>('30');
  const [ipPrefix, setIpPrefix] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);

  const options = useResource((signal) => getAuditFilterOptions(signal), []);

  const query = useMemo<AuditQuery>(() => {
    const from = rangeToFrom(range, new Date());
    return {
      ...(actorId === '' ? {} : { actorId }),
      ...(action === '' ? {} : { action: action as AuditAction }),
      ...(objectType === '' ? {} : { objectType }),
      ...(from === undefined ? {} : { from }),
      ...(ipPrefix === '' ? {} : { sourceIpPrefix: ipPrefix }),
    };
  }, [actorId, action, objectType, range, ipPrefix]);

  const events = useResource(
    useCallback((signal: AbortSignal) => listAuditEvents(query, PAGE_SIZE, signal), [query]),
    [actorId, action, objectType, range, ipPrefix],
  );

  const clearAll = () => {
    setActorId('');
    setAction('');
    setObjectType('');
    setRange('30');
    setIpPrefix('');
  };

  const toggleRow = (rowId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });

  const filterCount = activeFilterCount({ actorId, action, objectType, range, ipPrefix });
  const zoneName = zone === 'unknown' ? 'unknown' : formatZone(locale, new Date(), zone);
  const objectLabels = new Map(
    (options.data?.objectTypes ?? []).map((entry) => [entry.objectType, entry.label]),
  );
  const objectName = (type: string) =>
    isLabelledObjectType(type)
      ? t.t(`admin.audit.object.${type}` as MessageId)
      : (objectLabels.get(type) ?? humaniseKey(type));
  const rangeLabel = t.t(`admin.audit.filter.date.${range}` as MessageId);

  /** The chips that make an empty page attributable (see `activeFilterCount`). */
  const chips: { key: string; name: string; value: string; clear: () => void }[] = [];
  if (actorId !== '') {
    chips.push({
      key: 'actor',
      name: t.t('admin.audit.filter.actor'),
      value: options.data?.actors.find((actor) => actor.id === actorId)?.displayName ?? actorId,
      clear: () => setActorId(''),
    });
  }
  if (action !== '') {
    chips.push({
      key: 'action',
      name: t.t('admin.audit.filter.action'),
      value: t.t(`admin.audit.action.${action}` as MessageId),
      clear: () => setAction(''),
    });
  }
  if (objectType !== '') {
    chips.push({
      key: 'object',
      name: t.t('admin.audit.filter.object'),
      value: objectName(objectType),
      clear: () => setObjectType(''),
    });
  }
  if (range !== '30') {
    chips.push({
      key: 'date',
      name: t.t('admin.audit.filter.date'),
      value: rangeLabel,
      clear: () => setRange('30'),
    });
  }
  if (ipPrefix !== '') {
    chips.push({
      key: 'ip',
      name: t.t('admin.audit.filter.ip'),
      value: ipPrefix,
      clear: () => setIpPrefix(''),
    });
  }

  const FILTER_SELECT =
    'h-control-md w-full min-w-0 cursor-pointer rounded-md border border-border-strong bg-surface ps-2.5 pe-2 text-body-sm font-normal text-text is-focus:field-focus';

  return (
    <AdminShell
      locale={locale}
      messages={messages}
      locales={locales}
      linkedSettings={linkedSettings}
      bell={bell}
      activeSettingId="audit"
    >
      <div data-screen="P02/E" className="flex min-w-0 flex-col gap-6">
        <PageHeader
          eyebrow={t.t('admin.audit.eyebrow')}
          title={t.t('admin.audit.title')}
          intro={t.t('admin.audit.intro')}
          actions={
            <AdminButton
              data-testid="audit-export-open"
              icon="download"
              onClick={() => setExportOpen(true)}
            >
              {t.t('admin.audit.export')}
            </AdminButton>
          }
        />

        <div
          role="search"
          aria-label={t.t('admin.audit.filters')}
          className={`${CARD} grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5`}
        >
          <label className="flex min-w-0 flex-col gap-1.5 text-meta font-bold">
            {t.t('admin.audit.filter.actor')}
            <select
              data-testid="audit-actor"
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              className={FILTER_SELECT}
            >
              <option value="">{t.t('admin.audit.filter.actor.any')}</option>
              {(options.data?.actors ?? [])
                .filter((actor) => actor.id !== null && actor.id !== undefined)
                .map((actor) => (
                  <option key={actor.id} value={actor.id ?? ''}>
                    {actor.displayName}
                  </option>
                ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1.5 text-meta font-bold">
            {t.t('admin.audit.filter.action')}
            <select
              data-testid="audit-action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className={FILTER_SELECT}
            >
              <option value="">{t.t('admin.audit.filter.action.any')}</option>
              {(options.data?.actions ?? []).map((value) => (
                <option key={value} value={value}>
                  {t.t(`admin.audit.action.${value}` as MessageId)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1.5 text-meta font-bold">
            {t.t('admin.audit.filter.object')}
            <select
              data-testid="audit-object"
              value={objectType}
              onChange={(event) => setObjectType(event.target.value)}
              className={FILTER_SELECT}
            >
              <option value="">{t.t('admin.audit.filter.object.any')}</option>
              {(options.data?.objectTypes ?? []).map((value) => (
                <option key={value.objectType} value={value.objectType}>
                  {objectName(value.objectType)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1.5 text-meta font-bold">
            {t.t('admin.audit.filter.date')}
            <select
              data-testid="audit-range"
              value={range}
              onChange={(event) => setRange(event.target.value as AuditRangeKey)}
              className={FILTER_SELECT}
            >
              {AUDIT_RANGES.map((value) => (
                <option key={value} value={value}>
                  {t.t(`admin.audit.filter.date.${value}` as MessageId)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1.5 text-meta font-bold">
            {t.t('admin.audit.filter.ip')}
            <input
              data-testid="audit-ip"
              value={ipPrefix}
              onChange={(event) => setIpPrefix(event.target.value)}
              placeholder={t.t('admin.audit.filter.ip.hint')}
              inputMode="numeric"
              className="h-control-md w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 font-mono text-meta font-normal text-text placeholder:text-text-muted is-focus:field-focus"
            />
          </label>
        </div>

        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <span data-testid="audit-count" className="text-meta font-semibold text-text-2">
            {t.t('admin.audit.summary', {
              events: t.t('admin.audit.count', { count: events.data?.items.length ?? 0 }),
              range: rangeLabel,
            })}
          </span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft pe-1 ps-2.5 text-meta font-semibold text-primary-text"
            >
              {t.t('admin.audit.chip', { name: chip.name, value: chip.value })}
              <button
                type="button"
                aria-label={t.t('admin.audit.chip.remove', { name: chip.name })}
                onClick={chip.clear}
                className="flex size-5 items-center justify-center rounded-full outline-none is-hover:bg-primary-soft-strong is-focus-visible:ring-focus"
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          ))}
          {filterCount === 0 ? null : (
            <button type="button" data-testid="audit-clear" onClick={clearAll} className={TEXT_ACTION}>
              {t.t('admin.audit.clearAll')}
            </button>
          )}
        </div>

        <Panel t={t} resource={events} skeletonRows={10}>
          {(page) =>
            page.items.length === 0 ? (
              <div
                data-screen="P02/E1"
                data-testid="audit-empty"
                className={`${CARD} flex flex-col items-center gap-2.5 px-6 py-16 text-center`}
              >
                <span className="flex size-16 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                  <Icon name="manage_search" size={32} />
                </span>
                <b className="text-h5 font-bold">{t.t('admin.audit.empty.title')}</b>
                <p className="m-0 max-w-md text-pretty text-body-sm text-text-2">
                  {t.t('admin.audit.empty.body')}
                </p>
                <AdminButton data-testid="audit-empty-clear" onClick={clearAll} className="mt-1.5">
                  {t.t('admin.audit.empty.clear')}
                </AdminButton>
              </div>
            ) : (
              <div className={`${CARD} min-w-0 overflow-hidden`}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-body-sm">
                    <caption className="sr-only">{t.t('admin.audit.title')}</caption>
                    <thead className={TABLE_HEAD}>
                      <tr className="border-b border-border">
                        <th scope="col" className="w-40 pe-2 ps-4 text-start font-bold">
                          {t.t('admin.audit.col.time', { zone: zoneName })}
                        </th>
                        <th scope="col" className="px-2 text-start font-bold">
                          {t.t('admin.audit.col.actor')}
                        </th>
                        <th scope="col" className="w-36 px-2 text-start font-bold">
                          {t.t('admin.audit.col.action')}
                        </th>
                        <th scope="col" className="px-2 text-start font-bold">
                          {t.t('admin.audit.col.object')}
                        </th>
                        <th scope="col" className="w-44 px-2 text-start font-bold">
                          {t.t('admin.audit.col.ip')}
                        </th>
                        <th scope="col" className="w-14">
                          <span className="sr-only">{t.t('admin.audit.col.detail')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.items.map((entry) => {
                        const label = withheldIfIdentifier(entry.objectLabel);
                        const open = expanded.has(entry.id);
                        const type = objectName(entry.objectType);
                        const record =
                          label !== null && looksLikeId(label)
                            ? t.t('admin.audit.record.id', { id: label.slice(0, 8) })
                            : label;
                        const detailId = `audit-detail-${entry.id}`;
                        return (
                          <Fragment key={entry.id}>
                            <tr
                              data-testid="audit-row"
                              data-action={entry.action}
                              className={`${open ? 'bg-surface-sunken' : 'border-b border-border last:border-b-0'}`}
                            >
                              <td className="py-2 pe-2 ps-4 text-meta text-text-2">
                                <time dateTime={entry.occurredAt}>
                                  {formatStamp(locale, entry.occurredAt, zone === 'unknown' ? undefined : zone)}
                                </time>
                              </td>
                              <td className="px-2 py-2">
                                <span className="flex min-w-0 items-center gap-2">
                                  {entry.actor.kind === 'system' ? (
                                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-text-2">
                                      <Icon name="smart_toy" size={16} />
                                    </span>
                                  ) : (
                                    <span
                                      aria-hidden="true"
                                      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-micro text-primary-text"
                                    >
                                      {initials(entry.actor.displayName)}
                                    </span>
                                  )}
                                  <span className="flex min-w-0 flex-col">
                                    <b className="font-semibold">{entry.actor.displayName}</b>
                                    <span className="text-caption font-normal text-text-muted">
                                      {entry.actor.roleName ?? t.t('admin.prog.unknown')}
                                    </span>
                                  </span>
                                </span>
                              </td>
                              <td className="px-2 py-2">
                                <Pill tone={auditActionTone(entry.action)}>
                                  {t.t(`admin.audit.action.${entry.action}` as MessageId)}
                                </Pill>
                              </td>
                              <td className="px-2 py-2">
                                <span className="flex min-w-0 flex-col">
                                  <span className="font-semibold">{type}</span>
                                  {record === null ? (
                                    <span
                                      data-testid="audit-object-withheld"
                                      className="text-meta text-text-muted"
                                    >
                                      {t.t('admin.audit.object.withheld')}
                                    </span>
                                  ) : (
                                    <span className="max-w-80 truncate text-meta text-text-2">{record}</span>
                                  )}
                                </span>
                              </td>
                              {/* ONE rendering for "you may not see this" and for
                                  "none recorded". Telling them apart would make the
                                  column an oracle. */}
                              <td className="px-2 py-2" data-testid="audit-ip-cell">
                                <span className="flex flex-col">
                                  <span className="font-mono text-meta">
                                    {entry.sourceIp ?? t.t('admin.audit.ip.notShown')}
                                  </span>
                                  <span className="text-caption font-normal text-text-muted">
                                    {entry.sourceLocation ?? t.t('admin.prog.unknown')}
                                  </span>
                                </span>
                              </td>
                              <td className="py-2 pe-2">
                                <button
                                  type="button"
                                  data-testid="audit-expand"
                                  aria-expanded={open}
                                  aria-controls={open ? detailId : undefined}
                                  aria-label={t.t(
                                    open ? 'admin.audit.collapse' : 'admin.audit.expand',
                                    { label: type },
                                  )}
                                  onClick={() => toggleRow(entry.id)}
                                  className={`${ROW_ICON_BUTTON} size-10 text-text-2`}
                                >
                                  <Icon name={open ? 'expand_less' : 'expand_more'} size={22} />
                                </button>
                              </td>
                            </tr>
                            {open ? (
                              // The before/after detail is a full-width row under
                              // its event (P02/E), on the event's tint, aligned
                              // to the actor column from md up.
                              <tr className="border-b border-border bg-surface-sunken last:border-b-0">
                                <td colSpan={6} className="px-4 pb-3.5 md:ps-44">
                                  <div
                                    id={detailId}
                                    data-testid="audit-detail"
                                    className="overflow-hidden rounded-md border border-border bg-surface"
                                  >
                                    <div className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 bg-surface-sunken px-3.5 py-2 text-caption font-bold uppercase tracking-wider text-text-muted">
                                      <span>{t.t('admin.audit.diff.field')}</span>
                                      <span>{t.t('admin.audit.diff.before')}</span>
                                      <span>{t.t('admin.audit.diff.after')}</span>
                                    </div>
                                    {(entry.changes ?? []).length === 0 ? (
                                      <p className="m-0 border-t border-border px-3.5 py-2 text-meta text-text-2">
                                        {t.t('admin.audit.diff.empty')}
                                      </p>
                                    ) : (
                                      (entry.changes ?? []).map((change) => (
                                        <div
                                          key={change.field}
                                          data-testid="audit-change"
                                          data-redacted={change.redacted}
                                          className="grid grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-t border-border px-3.5 py-2 text-meta"
                                        >
                                          <span className="break-words font-semibold">{humaniseKey(change.field)}</span>
                                          {change.redacted ? (
                                            // The fact of the change is auditable;
                                            // its content is not. Rendered once,
                                            // spanning both columns, so there is no
                                            // "before" to read and no "after".
                                            <span
                                              data-testid="audit-redacted"
                                              className="col-span-2 flex items-center gap-2 text-text-muted"
                                            >
                                              <Icon name="visibility_off" size={16} />
                                              {t.t('admin.audit.diff.redacted')}
                                            </span>
                                          ) : (
                                            <>
                                              <span className="break-words font-mono text-danger-text line-through">
                                                {change.before ?? t.t('admin.audit.diff.none')}
                                              </span>
                                              <span className="break-words font-mono text-success-text">
                                                {change.after ?? t.t('admin.audit.diff.none')}
                                              </span>
                                            </>
                                          )}
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          }
        </Panel>

        <p className="-mt-2 m-0 text-caption font-normal text-text-muted">{t.t('admin.audit.ip.notShown.why')}</p>
      </div>

      {exportOpen ? (
        <ExportDialog t={t} query={query} onClose={() => setExportOpen(false)} />
      ) : null}
    </AdminShell>
  );
}

/**
 * `P02/E2`. An export is itself audited, and the dialog says so out loud —
 * that row is written before the job starts, not after it succeeds, because an
 * export that failed halfway still means somebody asked for the data.
 *
 * `includeIpAddresses` starts OFF, which is the contract's default and not the
 * design's. An export that carries personal data by default is one an admin
 * produces without deciding to; turning it on is a decision, and it is recorded.
 */
function ExportDialog({
  t,
  query,
  onClose,
}: {
  t: ReturnType<typeof createBundleTranslator>;
  query: AuditQuery;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [scope, setScope] = useState<'filtered' | 'last_90_days'>('filtered');
  const [includeIps, setIncludeIps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ScreenError | null>(null);
  const [queued, setQueued] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await createAuditExport({
      format,
      scope,
      includeIpAddresses: includeIps,
      ...(scope === 'filtered' ? { filters: query } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Never a URL and never the full address. A download link in an API
    // response is a link in a browser history, an access log and a `Referer`.
    setQueued(
      result.value.deliveryEmailHint === null || result.value.deliveryEmailHint === undefined
        ? t.t('admin.audit.export.queued.noHint')
        : t.t('admin.audit.export.queued', {
            hint: result.value.deliveryEmailHint,
            hours: result.value.linkExpiresAfterHours ?? 24,
          }),
    );
  };

  const choice = (selected: boolean) =>
    `flex min-h-touch flex-1 basis-40 cursor-pointer items-start gap-2.5 rounded-10 border px-3.5 py-3 ${
      selected ? 'border-primary bg-primary-soft' : 'border-border bg-surface is-hover:bg-surface-sunken'
    }`;

  return (
    <Dialog
      title={t.t('admin.audit.export.title')}
      body={t.t('admin.audit.export.body')}
      icon="download"
      tone="primary"
      testId="audit-export-dialog"
      closeLabel={t.t('admin.dialog.close')}
      onClose={onClose}
      footer={
        <>
          <AdminButton data-testid="audit-export-cancel" onClick={onClose}>
            {t.t('admin.audit.export.cancel')}
          </AdminButton>
          <AdminButton
            variant="primary"
            data-testid="audit-export-confirm"
            disabled={busy || queued !== null}
            onClick={() => void start()}
            className="font-bold"
          >
            {t.t('admin.audit.export.confirm')}
          </AdminButton>
        </>
      }
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-meta font-bold">{t.t('admin.audit.export.format')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['csv', 'json'] as const).map((value) => (
            <label key={value} className={choice(format === value)}>
              <input
                type="radio"
                name="audit-export-format"
                data-testid={`audit-export-format-${value}`}
                value={value}
                checked={format === value}
                onChange={() => setFormat(value)}
                className="mt-0.5 size-4.5 shrink-0 accent-primary"
              />
              <span className="flex flex-col">
                <b className="text-body-sm font-bold">{t.t(`admin.audit.export.format.${value}` as MessageId)}</b>
                <span className="text-caption font-normal text-text-2">
                  {t.t(`admin.audit.export.format.${value}.note` as MessageId)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-meta font-bold">{t.t('admin.audit.export.scope')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['filtered', 'last_90_days'] as const).map((value) => (
            <label key={value} className={choice(scope === value)}>
              <input
                type="radio"
                name="audit-export-scope"
                data-testid={`audit-export-scope-${value}`}
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                className="mt-0.5 size-4.5 shrink-0 accent-primary"
              />
              <span className="flex flex-col">
                <b className="text-body-sm font-bold">{t.t(`admin.audit.export.scope.${value}` as MessageId)}</b>
                <span className="text-caption font-normal text-text-2">
                  {t.t(`admin.audit.export.scope.${value}.note` as MessageId)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-sm" id="audit-export-ips-label">
            {t.t('admin.audit.export.ip')}
          </span>
          <span className="text-caption font-normal text-text-2">{t.t('admin.audit.export.ip.note')}</span>
        </span>
        <Switch
          data-testid="audit-export-ips"
          aria-labelledby="audit-export-ips-label"
          checked={includeIps}
          onCheckedChange={setIncludeIps}
        />
      </div>

      <p className="m-0 flex gap-2.5 rounded-10 bg-info-soft px-3.5 py-3 text-meta text-info-text">
        <Icon name="info" size={18} className="shrink-0" />
        {t.t('admin.audit.export.audited')}
      </p>

      {queued === null ? null : (
        <p
          role="status"
          data-testid="audit-export-queued"
          className="m-0 rounded-10 bg-success-soft px-3.5 py-3 text-meta text-success-text"
        >
          {queued}
        </p>
      )}

      {error === null ? null : (
        <p
          role="alert"
          data-testid="audit-export-error"
          data-error-code={error.code}
          className="m-0 rounded-10 bg-danger-soft px-3.5 py-3 text-meta text-danger-text"
        >
          {t.t(errorMessageId(error))}
        </p>
      )}
    </Dialog>
  );
}
