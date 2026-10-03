'use client';

import { useId, useRef, useState } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { FIELD, SECONDARY_BUTTON } from '../auth/button-classes';
import { splitAddresses, type InviteAddress } from '../../lib/invite-emails';
import { directionOf, rovingIndex } from '../../lib/roving';
import { StepHeading } from './onboarding-shell';

const TABS = ['email', 'link'] as const;
type Tab = (typeof TABS)[number];

export const INVITE_ROLES = ['agent', 'supervisor', 'admin'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/**
 * `P01/5.5` — invite the team.
 *
 * Paste many addresses at once; each becomes a chip, and a malformed one is
 * marked on the chip AND explained in words beside the field — colour alone is
 * not an error message (WCAG 1.4.1). Nothing is sent from here: there is no
 * invitation endpoint yet (T-0018), and the success screen says "on the list",
 * never "sent".
 *
 * The WhatsApp-link tab needs a server-issued link that does not exist yet,
 * so it explains the idea and says the link is not ready rather than showing a
 * made-up one somebody might share.
 */
export function InviteStep({
  t,
  invites,
  onInvites,
  role,
  onRole,
}: {
  t: Translator;
  invites: readonly InviteAddress[];
  onInvites: (next: readonly InviteAddress[]) => void;
  role: InviteRole;
  onRole: (next: InviteRole) => void;
}) {
  const id = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>('email');
  const [draft, setDraft] = useState('');

  const firstProblem = invites.find((entry) => entry.problem !== null);
  const valid = invites.filter((entry) => entry.problem === null);

  function commit(text: string) {
    const added = splitAddresses(text, invites);
    if (added.length > 0) onInvites([...invites, ...added]);
    setDraft('');
  }

  function onTabKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const next = rovingIndex(event.key, TABS.indexOf(tab), TABS.length, directionOf(tabsRef.current));
    const target = next === null ? undefined : TABS[next];
    if (target === undefined) return;
    event.preventDefault();
    setTab(target);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${target}"]`)?.focus();
  }

  return (
    <>
      <StepHeading title={t.t('invite.title')} subtitle={t.t('invite.subtitle')} />

      <div
        ref={tabsRef}
        role="tablist"
        aria-label={t.t('invite.tabs')}
        onKeyDown={onTabKey}
        className="flex gap-1 rounded-lg bg-surface-sunken p-1"
      >
        {TABS.map((value) => {
          const selected = value === tab;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${id}-tab-${value}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${value}`}
              tabIndex={selected ? 0 : -1}
              data-tab={value}
              onClick={() => setTab(value)}
              className={`flex min-h-touch flex-1 items-center justify-center gap-2 rounded-md text-body-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                selected ? 'bg-surface text-text shadow-1' : 'text-text-2'
              }`}
            >
              <Icon name={value === 'email' ? 'mail' : 'chat'} size="sm" />
              {t.t(`invite.tab.${value}` as MessageId)}
            </button>
          );
        })}
      </div>

      {tab === 'email' ? (
        <div
          role="tabpanel"
          id={`${id}-panel-email`}
          aria-labelledby={`${id}-tab-email`}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-emails`} className="text-body-sm font-semibold">
              {t.t('invite.emails.label')}
            </label>
            {invites.length > 0 ? (
              <ul data-testid="invite-chips" className="flex list-none flex-wrap gap-2 p-0">
                {invites.map((entry) => (
                  <li
                    key={entry.address}
                    data-invalid={entry.problem !== null}
                    className={`inline-flex items-center gap-1 rounded-full ps-3 text-body-sm ${
                      entry.problem === null
                        ? 'bg-surface-sunken text-text'
                        : 'border border-danger bg-danger-soft text-danger-text'
                    }`}
                  >
                    {entry.problem === null ? null : <Icon name="error" size="sm" />}
                    <span dir="ltr">{entry.address}</span>
                    <button
                      type="button"
                      aria-label={t.t('invite.emails.remove', { address: entry.address })}
                      onClick={() => onInvites(invites.filter((other) => other.address !== entry.address))}
                      className="flex min-h-touch min-w-touch items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      <Icon name="close" size="sm" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2">
              <input
                ref={inputRef}
                id={`${id}-emails`}
                type="text"
                inputMode="email"
                autoComplete="off"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  commit(`${draft} ${event.clipboardData.getData('text')}`);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault();
                    commit(draft);
                  }
                }}
                aria-invalid={firstProblem !== undefined}
                aria-describedby={`${id}-emails-help${firstProblem === undefined ? '' : ` ${id}-emails-error`}`}
                className={`${FIELD} min-w-0 flex-1`}
              />
              <button type="button" onClick={() => commit(draft)} className={SECONDARY_BUTTON}>
                {t.t('invite.emails.add')}
              </button>
            </div>
            <span id={`${id}-emails-help`} className="text-caption text-text-muted">
              {t.t('invite.emails.help')}
            </span>
            {firstProblem !== undefined ? (
              <span id={`${id}-emails-error`} data-testid="invite-error" className="text-body-sm text-danger-text">
                {t.t(
                  firstProblem.problem === 'missing_ending' ? 'invite.emails.missingEnding' : 'invite.emails.invalid',
                  { address: firstProblem.address },
                )}
              </span>
            ) : null}
          </div>

          <label className="flex flex-col gap-2">
            <span className="text-body-sm font-semibold">{t.t('invite.role')}</span>
            <select value={role} onChange={(event) => onRole(event.target.value as InviteRole)} className={FIELD}>
              {INVITE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {t.t(`invite.role.${value}` as MessageId)}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${id}-panel-link`}
          aria-labelledby={`${id}-tab-link`}
          className="flex flex-col gap-3"
        >
          <p className="text-body-sm text-text-2">{t.t('invite.link.body')}</p>
          <p role="status" className="rounded-lg bg-info-soft p-3 text-body-sm text-info-text">
            {t.t('invite.link.unavailable')}
          </p>
        </div>
      )}

      <div data-testid="invite-summary" className="flex flex-col gap-1 rounded-lg border border-dashed border-border-strong p-4 text-center">
        {valid.length === 0 ? (
          <>
            <strong className="text-body-md">{t.t('invite.empty.title')}</strong>
            <span className="text-body-sm text-text-2">{t.t('invite.empty.body')}</span>
          </>
        ) : (
          <strong className="text-body-md">{t.t('invite.count', { count: valid.length })}</strong>
        )}
      </div>
    </>
  );
}
