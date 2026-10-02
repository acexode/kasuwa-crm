'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { Panel, errorMessageId } from './panel';
import { useResource } from './use-resource';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import {
  getSla,
  saveSla,
  type ProgrammeChannel,
  type ScreenError,
  type SlaClock,
  type SlaNotifyRole,
  type SlaPolicy,
} from '../../lib/admin-api';
import { formatDuration, parseDuration } from '../../lib/admin-format';

/**
 * `P02/B4` — the SLA tab, and the unsaved-changes behaviour the whole console
 * inherits from it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING SAVES BY SURPRISE, AND NOTHING IS LOST BY SURPRISE.
 *
 * Four things together, and the design is explicit that it is all four:
 *
 *   1. An edited field is marked amber, so you can see WHICH values changed
 *      after scrolling away from them.
 *   2. One bar counts the changes and names them.
 *   3. Save and Discard are both there. A bar with only Save teaches people to
 *      reload the page to undo, which loses the rest of their work.
 *   4. Leaving the page asks first (`use-unsaved-guard.ts`).
 *
 * An SLA target is a contractual number. Losing an edit silently and
 * overwriting a colleague's edit silently are the same class of failure, and
 * the second one ends in a service-credit dispute — which is why `version`
 * goes back on every write and a `409 stale_write` re-reads instead of
 * retrying.
 * ---------------------------------------------------------------------------
 *
 * The write is a WHOLE DOCUMENT, matching the screen: the bar saves everything
 * together, and a partial write would let two of four channel targets land and
 * leave the client unsure which.
 */

const CHANNEL_ICON: Readonly<Record<ProgrammeChannel, IconName>> = {
  whatsapp: 'chat',
  voice: 'call',
  sms: 'sms',
  email: 'mail',
  ussd: 'dialpad',
};

const CLOCKS: readonly SlaClock[] = ['business_hours', 'always'];
const WARN_PERCENTS: readonly number[] = [50, 75, 80, 90];
const WARN_ROLES: readonly SlaNotifyRole[] = ['assigned_agent', 'team_lead', 'programme_manager'];
const BREACH_ROLES: readonly SlaNotifyRole[] = [
  'team_lead',
  'programme_manager',
  'programme_manager_and_client',
];

interface Draft {
  /** Raw text per channel, so what the person typed survives a failed parse. */
  readonly first: Readonly<Record<string, string>>;
  readonly resolution: Readonly<Record<string, string>>;
  readonly clock: Readonly<Record<string, SlaClock>>;
  readonly pauseOutsideOperatingHours: boolean;
  readonly pauseAwaitingCustomer: boolean;
  readonly warnAtPercentOfTarget: number;
  readonly warnNotifyRole: SlaNotifyRole;
  readonly breachNotifyRole: SlaNotifyRole;
}

function toDraft(policy: SlaPolicy, locale: string): Draft {
  const first: Record<string, string> = {};
  const resolution: Record<string, string> = {};
  const clock: Record<string, SlaClock> = {};
  for (const target of policy.targets) {
    first[target.channel] =
      target.firstResponseSeconds === null ? '' : formatDuration(locale, target.firstResponseSeconds);
    resolution[target.channel] =
      target.resolutionSeconds === null ? '' : formatDuration(locale, target.resolutionSeconds);
    clock[target.channel] = target.clock;
  }
  return {
    first,
    resolution,
    clock,
    pauseOutsideOperatingHours: policy.pauseOutsideOperatingHours,
    pauseAwaitingCustomer: policy.pauseAwaitingCustomer,
    warnAtPercentOfTarget: policy.warnAtPercentOfTarget,
    warnNotifyRole: policy.warnNotifyRole ?? 'team_lead',
    breachNotifyRole: policy.breachNotifyRole ?? 'programme_manager',
  };
}

/** Which fields differ from what was loaded. The amber marks and the count. */
export function changedFields(policy: SlaPolicy, draft: Draft, locale: string): readonly string[] {
  const changed: string[] = [];
  const base = toDraft(policy, locale);

  for (const target of policy.targets) {
    if ((draft.first[target.channel] ?? '') !== (base.first[target.channel] ?? '')) {
      changed.push(`first:${target.channel}`);
    }
    if ((draft.resolution[target.channel] ?? '') !== (base.resolution[target.channel] ?? '')) {
      changed.push(`resolution:${target.channel}`);
    }
    if (draft.clock[target.channel] !== base.clock[target.channel]) {
      changed.push(`clock:${target.channel}`);
    }
  }
  if (draft.pauseOutsideOperatingHours !== base.pauseOutsideOperatingHours) {
    changed.push('pauseOutsideOperatingHours');
  }
  if (draft.pauseAwaitingCustomer !== base.pauseAwaitingCustomer) {
    changed.push('pauseAwaitingCustomer');
  }
  if (draft.warnAtPercentOfTarget !== base.warnAtPercentOfTarget) changed.push('warnAtPercentOfTarget');
  if (draft.warnNotifyRole !== base.warnNotifyRole) changed.push('warnNotifyRole');
  if (draft.breachNotifyRole !== base.breachNotifyRole) changed.push('breachNotifyRole');
  return changed;
}

export function SlaTab({
  t,
  locale,
  programmeId,
  onDirtyChange,
  discardSignal,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
  onDirtyChange: (count: number) => void;
  /** Incremented by the "Discard and leave" dialog. */
  discardSignal: number;
}) {
  const policy = useResource(
    useCallback((signal: AbortSignal) => getSla(programmeId, signal), [programmeId]),
    [programmeId],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ScreenError | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loaded = policy.data;

  useEffect(() => {
    if (loaded !== null) setDraft(toDraft(loaded, locale));
  }, [loaded, locale, discardSignal]);

  const changed = useMemo(
    () => (loaded === null || draft === null ? [] : changedFields(loaded, draft, locale)),
    [loaded, draft, locale],
  );

  useEffect(() => {
    onDirtyChange(changed.length);
  }, [changed.length, onDirtyChange]);

  const invalid = useMemo(() => {
    if (draft === null || loaded === null) return [] as string[];
    const problems: string[] = [];
    for (const target of loaded.targets) {
      const firstText = draft.first[target.channel] ?? '';
      if (firstText !== '' && parseDuration(locale, firstText) === null) {
        problems.push(`first:${target.channel}`);
      }
      const resolutionText = draft.resolution[target.channel] ?? '';
      if (resolutionText !== '' && parseDuration(locale, resolutionText) === null) {
        problems.push(`resolution:${target.channel}`);
      }
    }
    return problems;
  }, [draft, loaded, locale]);

  const discard = () => {
    if (loaded !== null) setDraft(toDraft(loaded, locale));
    setSaveError(null);
    setToast(t.t('admin.unsaved.discarded'));
  };

  const save = async () => {
    if (loaded === null || draft === null || invalid.length > 0) return;
    setSaving(true);
    setSaveError(null);
    const result = await saveSla(programmeId, {
      version: loaded.version,
      targets: loaded.targets.map((target) => ({
        channel: target.channel,
        firstResponseSeconds: parseDuration(locale, draft.first[target.channel] ?? ''),
        resolutionSeconds: parseDuration(locale, draft.resolution[target.channel] ?? ''),
        clock: draft.clock[target.channel] ?? target.clock,
      })),
      pauseOutsideOperatingHours: draft.pauseOutsideOperatingHours,
      pauseAwaitingCustomer: draft.pauseAwaitingCustomer,
      warnAtPercentOfTarget: draft.warnAtPercentOfTarget,
      warnNotifyRole: draft.warnNotifyRole,
      breachNotifyRole: draft.breachNotifyRole,
    });
    setSaving(false);
    if (result.ok) {
      setToast(t.t('admin.unsaved.saved'));
      policy.reload();
      return;
    }
    setSaveError(result.error);
    // A stale version is not a retry. Re-read so the person sees the value
    // their colleague saved before deciding what to do with their own.
    if (result.error.code === 'stale_write') policy.reload();
  };

  const mark = (field: string) =>
    changed.includes(field) ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface';

  const fieldClass = (field: string) =>
    `min-h-touch w-full rounded-md border px-3 text-body-md text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:border-danger ${mark(field)}`;

  return (
    <div data-screen="P02/B4" className="flex flex-col gap-4">
      <Panel t={t} resource={policy} skeletonRows={5}>
        {(data) =>
          draft === null ? null : (
            <>
              <section className="overflow-hidden rounded-lg border border-border bg-surface">
                <div className="flex flex-col gap-1 border-b border-border p-5">
                  <h2 className="text-h5">{t.t('admin.sla.title')}</h2>
                  <p className="text-body-sm text-text-2">{t.t('admin.sla.subtitle')}</p>
                </div>
                <div className="overflow-x-auto p-1">
                  <table className="w-full min-w-max border-collapse text-body-sm">
                    <caption className="sr-only">{t.t('admin.sla.title')}</caption>
                    <thead className="bg-surface-sunken text-caption uppercase text-text-muted">
                      <tr>
                        <th scope="col" className="p-3 text-start font-bold">
                          {t.t('admin.sla.col.channel')}
                        </th>
                        <th scope="col" className="p-3 text-start font-bold">
                          {t.t('admin.sla.col.first')}
                        </th>
                        <th scope="col" className="p-3 text-start font-bold">
                          {t.t('admin.sla.col.resolution')}
                        </th>
                        <th scope="col" className="p-3 text-start font-bold">
                          {t.t('admin.sla.col.clock')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.targets.map((target) => {
                        const channelName = t.t(`admin.channel.${target.channel}` as MessageId);
                        const firstField = `first:${target.channel}`;
                        const resolutionField = `resolution:${target.channel}`;
                        const clockField = `clock:${target.channel}`;
                        return (
                          <tr key={target.channel} className="border-t border-border align-top">
                            <th scope="row" className="p-3 text-start">
                              <span className="flex items-center gap-2 font-semibold">
                                <Icon
                                  name={CHANNEL_ICON[target.channel]}
                                  size="sm"
                                  className="text-text-2"
                                />
                                {channelName}
                              </span>
                            </th>
                            <td className="p-3">
                              <input
                                value={draft.first[target.channel] ?? ''}
                                aria-label={t.t('admin.sla.field.first', { channel: channelName })}
                                aria-invalid={invalid.includes(firstField)}
                                data-testid={`sla-${firstField}`}
                                data-changed={changed.includes(firstField) ? 'true' : 'false'}
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    first: { ...draft.first, [target.channel]: event.target.value },
                                  })
                                }
                                className={fieldClass(firstField)}
                              />
                            </td>
                            <td className="p-3">
                              <input
                                value={draft.resolution[target.channel] ?? ''}
                                aria-label={t.t('admin.sla.field.resolution', {
                                  channel: channelName,
                                })}
                                aria-invalid={invalid.includes(resolutionField)}
                                data-testid={`sla-${resolutionField}`}
                                data-changed={changed.includes(resolutionField) ? 'true' : 'false'}
                                placeholder={t.t('admin.sla.noTarget')}
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    resolution: {
                                      ...draft.resolution,
                                      [target.channel]: event.target.value,
                                    },
                                  })
                                }
                                className={fieldClass(resolutionField)}
                              />
                            </td>
                            <td className="p-3">
                              <select
                                value={draft.clock[target.channel] ?? target.clock}
                                aria-label={t.t('admin.sla.field.clock', { channel: channelName })}
                                data-testid={`sla-${clockField}`}
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    clock: {
                                      ...draft.clock,
                                      [target.channel]: event.target.value as SlaClock,
                                    },
                                  })
                                }
                                className={fieldClass(clockField)}
                              >
                                {CLOCKS.map((clock) => (
                                  <option key={clock} value={clock}>
                                    {t.t(`admin.sla.clock.${clock}` as MessageId)}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {invalid.length > 0 ? (
                  <p role="alert" className="p-4 text-body-sm text-danger-text">
                    {t.t('admin.sla.invalid')}
                  </p>
                ) : null}
              </section>

              <div className="grid gap-4 xl:grid-cols-2">
                <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
                  <h2 className="text-h5">{t.t('admin.sla.clock.title')}</h2>
                  <Toggle
                    label={t.t('admin.sla.pauseHours')}
                    note={data.operatingHoursSummary ?? null}
                    checked={draft.pauseOutsideOperatingHours}
                    changed={changed.includes('pauseOutsideOperatingHours')}
                    changedLabel={t.t('admin.sla.edited')}
                    testId="sla-pause-hours"
                    onChange={(value) =>
                      setDraft({ ...draft, pauseOutsideOperatingHours: value })
                    }
                  />
                  <Toggle
                    label={t.t('admin.sla.pauseCustomer')}
                    note={t.t('admin.sla.pauseCustomer.note')}
                    checked={draft.pauseAwaitingCustomer}
                    changed={changed.includes('pauseAwaitingCustomer')}
                    changedLabel={t.t('admin.sla.edited')}
                    testId="sla-pause-customer"
                    onChange={(value) => setDraft({ ...draft, pauseAwaitingCustomer: value })}
                  />
                </section>

                <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
                  <h2 className="text-h5">{t.t('admin.sla.escalation')}</h2>
                  <div className="flex flex-wrap items-center gap-2 text-body-sm">
                    <span className="font-semibold">{t.t('admin.sla.warnAt')}</span>
                    <select
                      value={draft.warnAtPercentOfTarget}
                      aria-label={t.t('admin.sla.warnAt')}
                      data-testid="sla-warn-at"
                      onChange={(event) =>
                        setDraft({ ...draft, warnAtPercentOfTarget: Number(event.target.value) })
                      }
                      className={fieldClass('warnAtPercentOfTarget')}
                    >
                      {WARN_PERCENTS.map((percent) => (
                        <option key={percent} value={percent}>
                          {t.t('admin.sla.percentOfTarget', { percent })}
                        </option>
                      ))}
                    </select>
                    <span>{t.t('admin.sla.warnNotify')}</span>
                    <select
                      value={draft.warnNotifyRole}
                      aria-label={t.t('admin.sla.warnNotify')}
                      data-testid="sla-warn-role"
                      onChange={(event) =>
                        setDraft({ ...draft, warnNotifyRole: event.target.value as SlaNotifyRole })
                      }
                      className={fieldClass('warnNotifyRole')}
                    >
                      {WARN_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.t(`admin.sla.role.${role}` as MessageId)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-body-sm">
                    <span className="font-semibold">{t.t('admin.sla.onBreach')}</span>
                    <span>{t.t('admin.sla.breachNotify')}</span>
                    <select
                      value={draft.breachNotifyRole}
                      aria-label={t.t('admin.sla.breachNotify')}
                      data-testid="sla-breach-role"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          breachNotifyRole: event.target.value as SlaNotifyRole,
                        })
                      }
                      className={fieldClass('breachNotifyRole')}
                    >
                      {BREACH_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.t(`admin.sla.role.${role}` as MessageId)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-body-sm text-text-2">{t.t('admin.sla.credits')}</p>
                </section>
              </div>
            </>
          )
        }
      </Panel>

      {saveError === null ? null : (
        <p role="alert" data-testid="sla-save-error" data-error-code={saveError.code} className="rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
          {t.t(errorMessageId(saveError))}
        </p>
      )}

      {toast === null ? null : (
        <p role="status" data-testid="sla-toast" className="rounded-md bg-success-soft p-3 text-body-sm text-success-text">
          {toast}
        </p>
      )}

      {changed.length === 0 ? null : (
        <div
          data-testid="unsaved-bar"
          className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-3 border-t border-border bg-inverse p-4 text-on-inverse"
        >
          <Icon name="edit_note" className="text-accent" />
          <b data-testid="unsaved-count" className="flex-1 text-body-sm">
            {t.t('admin.unsaved.count', { count: changed.length })}
          </b>
          <button
            type="button"
            data-testid="discard-changes"
            onClick={discard}
            className={`${SECONDARY_BUTTON} border-border-strong bg-transparent text-on-inverse`}
          >
            {t.t('admin.unsaved.discard')}
          </button>
          <button
            type="button"
            data-testid="save-changes"
            disabled={saving || invalid.length > 0}
            onClick={() => void save()}
            className="flex min-h-touch items-center justify-center rounded-md bg-accent px-4 text-body-md font-bold text-on-accent disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {saving ? t.t('admin.unsaved.saving') : t.t('admin.unsaved.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  note,
  checked,
  changed,
  changedLabel,
  testId,
  onChange,
}: {
  label: string;
  note: string | null;
  checked: boolean;
  changed: boolean;
  changedLabel: string;
  testId: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-4 border-t border-border py-3">
      <div className="flex flex-1 flex-col gap-1">
        <b className="text-body-sm font-semibold">{label}</b>
        {note === null ? null : <span className="text-body-sm text-text-2">{note}</span>}
        {changed ? <span className="text-caption font-bold text-accent-text">{changedLabel}</span> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-testid={testId}
        data-changed={changed ? 'true' : 'false'}
        onClick={() => onChange(!checked)}
        className={`flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
          changed ? 'bg-accent-soft' : ''
        }`}
      >
        <span
          className={`flex h-6 w-11 items-center rounded-full p-1 transition-colors duration-quick motion-reduce:transition-none ${
            checked ? 'justify-end bg-primary' : 'justify-start bg-border-strong'
          }`}
        >
          <span className="h-4 w-4 rounded-full bg-on-primary" />
        </span>
      </button>
    </div>
  );
}
