'use client';

import { useState } from 'react';
import { signOut } from '../../lib/auth-api';
import { SIGN_IN_PATH } from '../../lib/api-fetch';
import { QUIET_BUTTON } from './button-classes';

/**
 * Sign out (ADR-0019 point 5, I20), in the CRM and admin shells.
 *
 * The BFF revokes the session at the API and clears the cookie whatever the
 * API answered, so this always goes on to sign-in afterwards. A full
 * navigation rather than a router push: nothing of the signed-in screen, its
 * state or its cache should survive into the signed-out one.
 */
export function SignOutButton({ label }: { label: string }) {
  const [pending, setPending] = useState(false);
  return (
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
      className={`${QUIET_BUTTON} shrink-0 disabled:opacity-60`}
    >
      {label}
    </button>
  );
}
