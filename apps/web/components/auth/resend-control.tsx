'use client';

import { useEffect, useState } from 'react';
import { SECONDARY_BUTTON } from './button-classes';

/**
 * The live resend countdown from `P01/2a`, also used by `P01/4`.
 *
 * Counts down to the server's `resendAvailableAt` rather than from sixty. The
 * two disagree the moment a tab is backgrounded or a phone sleeps, and the
 * version that disagrees in the user's favour is the one that enables a button
 * the server will refuse.
 */
export function ResendControl({
  resendAt,
  waitingLabel,
  nowLabel,
  onResend,
  disabled,
  testIdPrefix = 'resend',
}: {
  resendAt: string | null;
  waitingLabel: (clock: string) => string;
  nowLabel: string;
  onResend: () => void;
  disabled: boolean;
  testIdPrefix?: string;
}) {
  const [remaining, setRemaining] = useState(() => secondsUntil(resendAt));

  useEffect(() => {
    setRemaining(secondsUntil(resendAt));
    const timer = window.setInterval(() => setRemaining(secondsUntil(resendAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  if (remaining <= 0) {
    return (
      <button
        type="button"
        onClick={onResend}
        disabled={disabled}
        data-testid={`${testIdPrefix}-now`}
        className={SECONDARY_BUTTON}
      >
        {nowLabel}
      </button>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  return (
    <p aria-live="polite" data-testid={`${testIdPrefix}-countdown`} className="text-body-sm text-text-2">
      {waitingLabel(`${minutes}:${seconds}`)}
    </p>
  );
}

function secondsUntil(iso: string | null): number {
  if (iso === null) return 0;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - Date.now()) / 1_000));
}
