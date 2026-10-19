'use client';

import { useEffect, useState } from 'react';
import { signOut } from '../../lib/sign-out';
import { SIGN_IN_PATH } from '../../lib/api-fetch';
import { Icon } from '../icon';
import { QUIET_BUTTON } from './button-classes';

/**
 * Sign out (ADR-0019 point 5, I20), in the CRM and admin shells.
 *
 * FROM `sm` UP it is an inline header button. BELOW `sm` (a 360 px phone)
 * the header has no room for it: it sits behind a 44 px account button
 * (`data-testid="user-menu"`) and drops down when that is pressed. It is ONE
 * element either way, so `[data-testid="sign-out"]` is never ambiguous.
 *
 * The BFF revokes the session at the API and clears the cookie whatever the
 * API answered, so this always goes on to sign-in afterwards: a full
 * navigation, so nothing of the signed-in screen, its state or its cache
 * survives into the signed-out one. (Loading the sign-out code on the press
 * instead was measured: it saved 5 bytes of /contacts and added a round trip
 * at sign-out, because `api-fetch` ships with the transports anyway.)
 */
export function SignOutButton({ label, menuLabel }: { label: string; menuLabel: string }) {
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative flex shrink-0">
      <button
        type="button"
        data-testid="user-menu"
        aria-label={menuLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-touch min-w-touch items-center justify-center rounded-md hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:hidden"
      >
        <Icon name="person" size="sm" />
      </button>
      <button
        type="button"
        data-testid="sign-out"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void signOut().then(() => {
            window.location.assign(SIGN_IN_PATH);
          });
        }}
        className={`${QUIET_BUTTON} shrink-0 whitespace-nowrap disabled:opacity-60 ${
          open ? 'absolute end-0 top-full z-40 mt-1 border border-border bg-surface-raised shadow-3' : 'hidden'
        } sm:static sm:mt-0 sm:flex sm:border-0 sm:bg-transparent sm:shadow-none`}
      >
        {label}
      </button>
    </div>
  );
}
