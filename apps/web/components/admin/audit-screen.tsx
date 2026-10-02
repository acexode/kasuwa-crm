'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AdminShell } from './admin-shell';
import { Panel, errorMessageId } from './panel';
import { Dialog } from './dialog';
import { useResource } from './use-resource';
import type { LanguageOption } from '../auth/language-menu';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import {
  createAuditExport,
  getAuditFilterOptions,
  listAuditEvents,
  type AuditAction,
  type AuditQuery,
  type ScreenError,
} from '../../lib/admin-api';
import { AUDIT_RANGES, rangeToFrom, withheldIfIdentifier, type AuditRangeKey } from '../../lib/admin-audit';
import { formatDateTime } from '../../lib/admin-format';

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
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
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

  return (
    <AdminShell locale={locale} messages={messages} locales={locales} activeSettingId="audit">
      <div data-screen="P02/E" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-body-sm font-semibold text-text-muted">
              {t.t('admin.audit.eyebrow')}
            </span>
            <h1 className="text-h2">{t.t('admin.audit.title')}</h1>
            <p className="max-w-prose text-body-md text-text-2">{t.t('admin.audit.intro')}</p>
          </div>
          <button
            type="button"
            data-testid="audit-export-open"
            onClick={() => setExportOpen(true)}
            className={SECONDARY_BUTTON}
          >
            <Icon name="description" size="sm" />
            {t.t('admin.audit.export')}
          </button>
        </div>

        <div
          role="search"
          aria-label={t.t('admin.audit.filters')}
          className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5"
        >
          <label className="flex flex-col gap-2 text-body-sm font-bold">
            {t.t('admin.audit.filter.actor')}
            <select
              data-testid="audit-actor"
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md font-normal text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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

          <label className="flex flex-col gap-2 text-body-sm font-bold">
            {t.t('admin.audit.filter.action')}
            <select
              data-testid="audit-action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md font-normal text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <option value="">{t.t('admin.audit.filter.action.any')}</option>
              {(options.data?.actions ?? []).map((value) => (
                <option key={value} value={value}>
                  {t.t(`admin.audit.action.${value}` as MessageId)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2 text-body-sm font-bold">
            {t.t('admin.audit.filter.object')}
            <select
              data-testid="audit-object"
              value={objectType}
              onChange={(event) => setObjectType(event.target.value)}
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md font-normal text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <option value="">{t.t('admin.audit.filter.object.any')}</option>
              {(options.data?.objectTypes ?? []).map((value) => (
                <option key={value.objectType} value={value.objectType}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2 text-body-sm font-bold">
            {t.t('admin.audit.filter.date')}
            <select
              data-testid="audit-range"
              value={range}
              onChange={(event) => setRange(event.target.value as AuditRangeKey)}
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 text-body-md font-normal text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {AUDIT_RANGES.map((value) => (
                <option key={value} value={value}>
                  {t.t(`admin.audit.filter.date.${value}` as MessageId)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-2 text-body-sm font-bold">
            {t.t('admin.audit.filter.ip')}
            <input
              data-testid="audit-ip"
              value={ipPrefix}
              onChange={(event) => setIpPrefix(event.target.value)}
              placeholder={t.t('admin.audit.filter.ip.hint')}
              inputMode="numeric"
              className="min-h-touch rounded-md border border-border-strong bg-surface px-3 font-mono text-mono font-normal text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="audit-count" className="text-body-sm font-semibold text-text-2">
            {t.t('admin.audit.count', { count: events.data?.items.length ?? 0 })}
          </span>
          <button
            type="button"
            data-testid="audit-clear"
            onClick={clearAll}
            className={`${SECONDARY_BUTTON} border-0 bg-transparent text-primary-text`}
          >
            {t.t('admin.audit.clearAll')}
          </button>
        </div>

        <Panel t={t} resource={events} skeletonRows={10}>
          {(page) =>
            page.items.length === 0 ? (
              <div
                data-screen="P02/E1"
                data-testid="audit-empty"
                className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-16 text-center"
              >
                <Icon name="search_off" size="xl" className="text-text-muted" />
                <b className="text-h5">{t.t('admin.audit.empty.title')}</b>
                <p className="max-w-prose text-body-md text-text-2">
                  {t.t('admin.audit.empty.body')}
                </p>
                <button
                  type="button"
                  data-testid="audit-empty-clear"
                  onClick={clearAll}
                  className={SECONDARY_BUTTON}
                >
                  {t.t('admin.audit.empty.clear')}
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full min-w-max border-collapse text-body-sm">
                  <caption className="sr-only">{t.t('admin.audit.title')}</caption>
                  <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                    <tr>
                      <th scope="col" className="p-3 text-start font-bold">
                        {t.t('admin.audit.col.time', { zone })}
                      </th>
                      <th scope="col" className="p-3 text-start font-bold">
                        {t.t('admin.audit.col.actor')}
                      </th>
                      <th scope="col" className="p-3 text-start font-bold">
                        {t.t('admin.audit.col.action')}
                      </th>
                      <th scope="col" className="p-3 text-start font-bold">
                        {t.t('admin.audit.col.object')}
                      </th>
                      <th scope="col" className="p-3 text-start font-bold">
                        {t.t('admin.audit.col.ip')}
                      </th>
                      <th scope="col" className="p-3">
                        <span className="sr-only">{t.t('admin.audit.col.detail')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.items.map((entry) => {
                      const label = withheldIfIdentifier(entry.objectLabel);
                      const open = expanded.has(entry.id);
                      return (
                        <tr
                          key={entry.id}
                          data-testid="audit-row"
                          data-action={entry.action}
                          className="border-t border-border align-top"
                        >
                          <td className="p-3 text-text-2">
                            {formatDateTime(locale, entry.occurredAt, zone === 'unknown' ? undefined : zone)}
                          </td>
                          <td className="p-3">
                            <span className="flex items-center gap-2">
                              {entry.actor.kind === 'system' ? (
                                <Icon name="schedule" size="sm" className="text-text-2" />
                              ) : null}
                              <span className="flex flex-col">
                                <b className="font-semibold">{entry.actor.displayName}</b>
                                <span className="text-caption text-text-muted">
                                  {entry.actor.roleName ?? t.t('admin.prog.unknown')}
                                </span>
                              </span>
                            </span>
                          </td>
                          <td className="p-3">
                            <span className="inline-flex rounded-full bg-surface-sunken px-2 text-caption font-bold text-text-2">
                              {t.t(`admin.audit.action.${entry.action}` as MessageId)}
                            </span>
                          </td>
                          <td className="p-3">
                            <span className="flex flex-col">
                              <b className="font-semibold">{entry.objectType}</b>
                              {label === null ? (
                                <span
                                  data-testid="audit-object-withheld"
                                  className="text-text-muted"
                                >
                                  {t.t('admin.audit.object.withheld')}
                                </span>
                              ) : (
                                <span className="text-text-2">{label}</span>
                              )}
                            </span>
                          </td>
                          {/* ONE rendering for "you may not see this" and for
                              "none recorded". Telling them apart would make the
                              column an oracle. */}
                          <td className="p-3" data-testid="audit-ip-cell">
                            <span className="flex flex-col">
                              <span className="font-mono text-mono">
                                {entry.sourceIp ?? t.t('admin.audit.ip.notShown')}
                              </span>
                              <span className="text-caption text-text-muted">
                                {entry.sourceLocation ?? t.t('admin.prog.unknown')}
                              </span>
                            </span>
                          </td>
                          <td className="p-3">
                            <button
                              type="button"
                              data-testid="audit-expand"
                              aria-expanded={open}
                              aria-label={t.t(
                                open ? 'admin.audit.collapse' : 'admin.audit.expand',
                                { label: entry.objectType },
                              )}
                              onClick={() => toggleRow(entry.id)}
                              className="flex min-h-touch min-w-touch items-center justify-center rounded-md text-text-2 hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                            >
                              <Icon name={open ? 'expand_less' : 'expand_more'} size="sm" />
                            </button>
                            {open ? (
                              <div
                                data-testid="audit-detail"
                                className="mt-2 flex w-max max-w-prose flex-col rounded-md border border-border"
                              >
                                <span className="grid grid-cols-3 gap-3 bg-surface-sunken p-2 text-caption font-bold uppercase text-text-muted">
                                  <span>{t.t('admin.audit.diff.field')}</span>
                                  <span>{t.t('admin.audit.diff.before')}</span>
                                  <span>{t.t('admin.audit.diff.after')}</span>
                                </span>
                                {(entry.changes ?? []).length === 0 ? (
                                  <span className="p-2 text-text-2">
                                    {t.t('admin.audit.diff.empty')}
                                  </span>
                                ) : (
                                  (entry.changes ?? []).map((change) => (
                                    <span
                                      key={change.field}
                                      data-testid="audit-change"
                                      data-redacted={change.redacted}
                                      className="grid grid-cols-3 gap-3 border-t border-border p-2"
                                    >
                                      <span className="font-semibold">{change.field}</span>
                                      {change.redacted ? (
                                        // The fact of the change is auditable;
                                        // its content is not. Rendered once,
                                        // spanning both columns, so there is no
                                        // "before" to read and no "after".
                                        <span
                                          data-testid="audit-redacted"
                                          className="col-span-2 flex items-center gap-2 text-text-muted"
                                        >
                                          <Icon name="visibility_off" size="sm" />
                                          {t.t('admin.audit.diff.redacted')}
                                        </span>
                                      ) : (
                                        <>
                                          <span className="font-mono text-mono text-danger-text line-through">
                                            {change.before ?? t.t('admin.audit.diff.none')}
                                          </span>
                                          <span className="font-mono text-mono text-success-text">
                                            {change.after ?? t.t('admin.audit.diff.none')}
                                          </span>
                                        </>
                                      )}
                                    </span>
                                  ))
                                )}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Panel>

        <p className="text-body-sm text-text-muted">{t.t('admin.audit.ip.notShown.why')}</p>
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

  return (
    <Dialog
      title={t.t('admin.audit.export.title')}
      body={t.t('admin.audit.export.body')}
      icon="description"
      tone="info"
      testId="audit-export-dialog"
      closeLabel={t.t('admin.dialog.close')}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            data-testid="audit-export-cancel"
            onClick={onClose}
            className={SECONDARY_BUTTON}
          >
            {t.t('admin.audit.export.cancel')}
          </button>
          <button
            type="button"
            data-testid="audit-export-confirm"
            disabled={busy || queued !== null}
            onClick={() => void start()}
            className="flex min-h-touch items-center justify-center rounded-md bg-primary px-4 text-body-md font-bold text-on-primary disabled:opacity-60 hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.t('admin.audit.export.confirm')}
          </button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="text-body-sm font-bold">{t.t('admin.audit.export.format')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['csv', 'json'] as const).map((value) => (
            <label
              key={value}
              className="flex min-h-touch flex-1 items-center gap-2 rounded-md border border-border px-3 text-body-md"
            >
              <input
                type="radio"
                name="audit-export-format"
                data-testid={`audit-export-format-${value}`}
                value={value}
                checked={format === value}
                onChange={() => setFormat(value)}
                className="h-5 w-5 accent-primary"
              />
              <span className="flex flex-col">
                <b>{t.t(`admin.audit.export.format.${value}` as MessageId)}</b>
                <span className="text-caption text-text-2">
                  {t.t(`admin.audit.export.format.${value}.note` as MessageId)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-body-sm font-bold">{t.t('admin.audit.export.scope')}</legend>
        <div className="flex flex-wrap gap-2">
          {(['filtered', 'last_90_days'] as const).map((value) => (
            <label
              key={value}
              className="flex min-h-touch flex-1 items-center gap-2 rounded-md border border-border px-3 text-body-md"
            >
              <input
                type="radio"
                name="audit-export-scope"
                data-testid={`audit-export-scope-${value}`}
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                className="h-5 w-5 accent-primary"
              />
              <span className="flex flex-col">
                <b>{t.t(`admin.audit.export.scope.${value}` as MessageId)}</b>
                <span className="text-caption text-text-2">
                  {t.t(`admin.audit.export.scope.${value}.note` as MessageId)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex min-h-touch items-center gap-3 text-body-md">
        <input
          type="checkbox"
          role="switch"
          data-testid="audit-export-ips"
          checked={includeIps}
          onChange={(event) => setIncludeIps(event.target.checked)}
          className="h-5 w-5 accent-primary"
        />
        <span className="flex flex-col">
          {t.t('admin.audit.export.ip')}
          <span className="text-caption text-text-2">{t.t('admin.audit.export.ip.note')}</span>
        </span>
      </label>

      <p className="flex gap-2 rounded-md bg-info-soft p-3 text-body-sm text-info-text">
        <Icon name="info" size="sm" />
        {t.t('admin.audit.export.audited')}
      </p>

      {queued === null ? null : (
        <p
          role="status"
          data-testid="audit-export-queued"
          className="rounded-md bg-success-soft p-3 text-body-sm text-success-text"
        >
          {queued}
        </p>
      )}

      {error === null ? null : (
        <p
          role="alert"
          data-testid="audit-export-error"
          data-error-code={error.code}
          className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text"
        >
          {t.t(errorMessageId(error))}
        </p>
      )}
    </Dialog>
  );
}
