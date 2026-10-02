'use client';

import { useCallback } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { PRIMARY_BUTTON } from '../auth/button-classes';
import { listPortalUsers, type ProgrammeDetail } from '../../lib/admin-api';
import { formatDate } from '../../lib/admin-format';

/**
 * `P02/B8` — client-portal users. **Empty is the designed state**, not a
 * fallback, which is why the empty case is the larger half of this file.
 *
 * ---------------------------------------------------------------------------
 * THE ONE LIST THAT CARRIES AN EMAIL ADDRESS, AND IT IS MASKED.
 *
 * Everywhere else in this console an address is withheld. Here the row IS an
 * invitation and the address is the invitation's identity — an admin resending
 * an invite has to see where it goes. The contract still only returns
 * `emailMasked` (`p•••e@client.example`); the full address exists only on the
 * invitation the caller just created, and this screen never asks for it.
 *
 * So the row renders `emailMasked` and nothing else, and it is never used to
 * build a `mailto:` or copied into a title attribute — either would turn a
 * mask back into an address in the DOM.
 * ---------------------------------------------------------------------------
 *
 * "Invite portal user" is visibly disabled. `POST /portal-users/invitations`
 * answers `501` — portal users are M18 and nothing exists — and granting an
 * outsider sight of a programme is the last control in this console that
 * should look live before it is.
 */

const STATUS_TONE: Readonly<Record<string, string>> = {
  invited: 'bg-info-soft text-info-text',
  active: 'bg-success-soft text-success-text',
  suspended: 'bg-warning-soft text-warning-text',
};

export function PortalTab({
  t,
  locale,
  programmeId,
  detail,
}: {
  t: Translator;
  locale: string;
  programmeId: string;
  detail: ProgrammeDetail | null;
}) {
  const users = useResource(
    useCallback((signal: AbortSignal) => listPortalUsers(programmeId, signal), [programmeId]),
    [programmeId],
  );

  const client = detail?.clientName;

  return (
    <div data-screen="P02/B8" className="flex flex-col gap-4">
      <Panel t={t} resource={users} skeletonRows={3}>
        {(data) =>
          data.items.length === 0 ? (
            <div
              data-testid="portal-empty"
              className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-14 text-center"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
                <Icon name="co_present" size="xl" />
              </span>
              <h2 className="text-h4">{t.t('admin.portal.empty.title')}</h2>
              {/* The client's name when we have it; a generic sentence when we
                  do not. "Invite people from undefined" is how that reads if
                  the name is interpolated unconditionally. */}
              <p className="max-w-prose text-body-md text-text-2">
                {client === null || client === undefined || client === ''
                  ? t.t('admin.portal.empty.body.noClient')
                  : t.t('admin.portal.empty.body', { client })}
              </p>
              {/* M18. Visibly not ready, rather than live and answering 501. */}
              <span
                className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`}
                aria-disabled
                data-testid="portal-invite"
              >
                <Icon name="person_add" size="sm" />
                {t.t('admin.portal.invite')}
              </span>
              <span className="text-body-sm text-text-muted">
                {t.t('admin.portal.notReady')}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex justify-end">
                <span
                  className={`${PRIMARY_BUTTON} pointer-events-none opacity-60`}
                  aria-disabled
                  data-testid="portal-invite"
                >
                  <Icon name="person_add" size="sm" />
                  {t.t('admin.portal.inviteAnother')}
                </span>
              </div>
              <ul className="flex flex-col rounded-lg border border-border bg-surface">
                {data.items.map((user) => (
                  <li
                    key={user.id}
                    data-testid="portal-row"
                    data-portal-status={user.status}
                    className="flex flex-wrap items-center gap-3 border-b border-border p-4 last:border-b-0"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-caption font-bold text-accent-text">
                      <Icon name="person" size="sm" />
                    </span>
                    <span className="flex min-w-48 flex-1 flex-col">
                      <b className="text-body-sm font-semibold">{user.displayName}</b>
                      {/* Masked, and only ever rendered as text. */}
                      <span data-testid="portal-email" className="text-body-sm text-text-muted">
                        {user.emailMasked}
                      </span>
                    </span>
                    <span className="text-body-sm text-text-2">
                      {t.t(`admin.portal.access.${user.access}` as MessageId)}
                    </span>
                    <span
                      className={`inline-flex rounded-full px-2 text-caption font-bold ${STATUS_TONE[user.status] ?? 'bg-surface-sunken text-text-2'}`}
                    >
                      {t.t(`admin.portal.status.${user.status}` as MessageId)}
                    </span>
                    <span className="text-body-sm text-text-muted">
                      {user.invitedAt === undefined
                        ? t.t('admin.prog.unknown')
                        : formatDate(locale, user.invitedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </Panel>
    </div>
  );
}
