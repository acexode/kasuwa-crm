'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { Icon } from '../icon';
import { Panel, errorMessageId } from './panel';
import { useResource } from './use-resource';
import { CARD, Notice, TABLE_HEAD, UnsavedBar } from './admin-ui';
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

  /** The export's 40px inline field and select: radius 8, 14px, a 1px edge (amber once edited). */
  const fieldClass = (field: string, width = 'w-full') =>
    `h-control-md ${width} min-w-0 rounded-md border px-3 text-body-sm text-text is-focus:field-focus aria-[invalid=true]:border-2 aria-[invalid=true]:border-danger ${mark(field)}`;
  const selectClass = (field: string, width = 'w-full') => `${fieldClass(field, width)} cursor-pointer ps-2.5`;

  return (
    <div data-screen="P02/B4" className="flex flex-col gap-6">
      <Panel t={t} resource={policy} skeletonRows={5}>
        {(data) =>
          draft === null ? null : (
            <>
              <section className={`${CARD} overflow-hidden`}>
                <div className="flex flex-col gap-1 border-b border-border px-5 py-4.5">
                  <h2 className="m-0 text-card-title">{t.t('admin.sla.title')}</h2>
                  <p className="m-0 text-meta text-text-2">{t.t('admin.sla.subtitle')}</p>
                </div>
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-body-sm">
                    <caption className="sr-only">{t.t('admin.sla.title')}</caption>
                    <thead className={TABLE_HEAD}>
                      <tr className="border-b border-border">
                        <th scope="col" className="w-40 ps-5 pe-1.5 text-start font-bold">
                          {t.t('admin.sla.col.channel')}
                        </th>
                        <th scope="col" className="px-1.5 text-start font-bold">
                          {t.t('admin.sla.col.first')}
                        </th>
                        <th scope="col" className="px-1.5 text-start font-bold">
                          {t.t('admin.sla.col.resolution')}
                        </th>
                        <th scope="col" className="pe-5 ps-1.5 text-start font-bold">
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
                          <tr key={target.channel} className="border-b border-border last:border-b-0">
                            <th scope="row" className="pe-1.5 ps-5 text-start">
                              <span className="flex items-center gap-2 font-semibold">
                                <Icon name={CHANNEL_ICON[target.channel]} size={20} className="text-text-2" />
                                {channelName}
                              </span>
                            </th>
                            <td className="px-1.5 py-2.5">
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
                            <td className="px-1.5 py-2.5">
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
                                className={`${fieldClass(resolutionField)} placeholder:text-text-muted`}
                              />
                            </td>
                            <td className="py-2.5 pe-5 ps-1.5">
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
                                className={selectClass(clockField)}
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
                  <p role="alert" className="m-0 border-t border-border px-5 py-3 text-meta text-danger-text">
                    {t.t('admin.sla.invalid')}
                  </p>
                ) : null}
              </section>

              <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <section className={`${CARD} flex flex-col gap-1 p-5`}>
                  <h2 className="m-0 mb-2.5 text-card-title">{t.t('admin.sla.clock.title')}</h2>
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

                <section className={`${CARD} flex flex-col gap-3 p-5`}>
                  <h2 className="m-0 mb-1 text-card-title">{t.t('admin.sla.escalation')}</h2>
                  <div className="flex flex-wrap items-center gap-2.5 text-body-sm">
                    <span className="font-semibold">{t.t('admin.sla.warnAt')}</span>
                    <select
                      value={draft.warnAtPercentOfTarget}
                      aria-label={t.t('admin.sla.warnAt')}
                      data-testid="sla-warn-at"
                      onChange={(event) =>
                        setDraft({ ...draft, warnAtPercentOfTarget: Number(event.target.value) })
                      }
                      className={selectClass('warnAtPercentOfTarget', 'w-auto')}
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
                      className={selectClass('warnNotifyRole', 'w-auto')}
                    >
                      {WARN_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.t(`admin.sla.role.${role}` as MessageId)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 text-body-sm">
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
                      className={selectClass('breachNotifyRole', 'w-auto')}
                    >
                      {BREACH_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t.t(`admin.sla.role.${role}` as MessageId)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="m-0 text-meta text-text-2">{t.t('admin.sla.credits')}</p>
                </section>
              </div>
            </>
          )
        }
      </Panel>

      {saveError === null ? null : (
        <Notice tone="danger" testId="sla-save-error" errorCode={saveError.code}>
          {t.t(errorMessageId(saveError))}
        </Notice>
      )}

      {toast === null ? null : (
        <Notice tone="success" testId="sla-toast">
          {toast}
        </Notice>
      )}

      {changed.length === 0 ? null : (
        <UnsavedBar
          label={t.t('admin.unsaved.region')}
          count={t.t('admin.unsaved.count', { count: changed.length })}
          detail={t.t('admin.sla.unsaved.detail', { count: changed.length })}
          discardLabel={t.t('admin.unsaved.discard')}
          saveLabel={t.t('admin.unsaved.save')}
          savingLabel={t.t('admin.unsaved.saving')}
          saving={saving}
          saveDisabled={invalid.length > 0}
          onDiscard={discard}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

/**
 * A setting with a switch (`P02/B4` Clock, `P02/B7`): the label at 14/600, its
 * note at 13 in text-2, and the v1.1 switch at the end, 44 by 26 with a 20px
 * knob. An edited switch says so in words, not only in colour.
 */
export function Toggle({
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
    <div className="flex items-center gap-4 border-t border-border py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-body-sm font-semibold">{label}</b>
        {note === null ? null : <span className="text-pretty text-meta text-text-2">{note}</span>}
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
        className={`flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full outline-none is-focus-visible:ring-focus ${
          changed ? 'bg-accent-soft' : ''
        }`}
      >
        <span
          className={`flex h-6.5 w-11 items-center rounded-full p-0.75 transition-colors duration-quick motion-reduce:transition-none ${
            checked ? 'justify-end bg-primary' : 'justify-start bg-border-strong'
          }`}
        >
          <span className="size-5 rounded-full bg-on-primary shadow-knob" />
        </span>
      </button>
    </div>
  );
}
