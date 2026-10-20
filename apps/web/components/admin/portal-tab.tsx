'use client';

import { useCallback } from 'react';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { Panel } from './panel';
import { useResource } from './use-resource';
import { AdminButton, CARD } from './admin-ui';
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
    <div data-screen="P02/B8" className="flex flex-col gap-6">
      <Panel t={t} resource={users} skeletonRows={3}>
        {(data) =>
          data.items.length === 0 ? (
            <div
              data-testid="portal-empty"
              className={`${CARD} flex flex-col items-center gap-2.5 px-6 py-14 text-center`}
            >
              <span className="flex size-16 items-center justify-center rounded-full bg-primary-soft text-primary-text">
                <Icon name="co_present" size={32} />
              </span>
              <h2 className="m-0 text-h4 font-bold">{t.t('admin.portal.empty.title')}</h2>
              {/* The client's name when we have it; a generic sentence when we
                  do not. "Invite people from undefined" is how that reads if
                  the name is interpolated unconditionally. */}
              <p className="m-0 max-w-md text-pretty text-label font-normal text-text-2">
                {client === null || client === undefined || client === ''
                  ? t.t('admin.portal.empty.body.noClient')
                  : t.t('admin.portal.empty.body', { client })}
              </p>
              {/* M18. Visibly not ready, rather than live and answering 501. */}
              <AdminButton variant="primary" icon="person_add" notReady data-testid="portal-invite" className="mt-1.5">
                {t.t('admin.portal.invite')}
              </AdminButton>
              <span className="text-meta text-text-muted">
                {t.t('admin.portal.notReady')}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex justify-end">
                <AdminButton variant="primary" icon="person_add" notReady data-testid="portal-invite">
                  {t.t('admin.portal.inviteAnother')}
                </AdminButton>
              </div>
              <ul className={`${CARD} m-0 flex list-none flex-col p-0`}>
                {data.items.map((user) => (
                  <li
                    key={user.id}
                    data-testid="portal-row"
                    data-portal-status={user.status}
                    className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3 last:border-b-0"
                  >
                    <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-caption font-bold text-accent-text">
                      <Icon name="person" size={18} />
                    </span>
                    <span className="flex min-w-48 flex-1 flex-col">
                      <b className="text-body-sm font-semibold">{user.displayName}</b>
                      {/* Masked, and only ever rendered as text. */}
                      <span data-testid="portal-email" className="text-meta text-text-muted">
                        {user.emailMasked}
                      </span>
                    </span>
                    <span className="text-body-sm text-text-2">
                      {t.t(`admin.portal.access.${user.access}` as MessageId)}
                    </span>
                    <span
                      className={`inline-flex h-5.5 items-center rounded-full px-2 text-caption font-bold ${STATUS_TONE[user.status] ?? 'bg-surface-sunken text-text-2'}`}
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
