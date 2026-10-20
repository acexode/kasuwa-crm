'use client';

import { useEffect, useState } from 'react';
import { Button } from '@kasuwa/ui/components';
import { Emphasis } from './rich-text';

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
      <Button
        onClick={onResend}
        disabled={disabled}
        data-testid={`${testIdPrefix}-now`}
        className="self-start"
      >
        {nowLabel}
      </Button>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  return (
    <p aria-live="polite" data-testid={`${testIdPrefix}-countdown`} className="text-body-sm text-text-2">
      <Emphasis
        sentence={(clock) => waitingLabel(clock ?? '')}
        values={[
          <strong key="clock" className="font-mono text-text">
            {`${minutes}:${seconds}`}
          </strong>,
        ]}
      />
    </p>
  );
}

function secondsUntil(iso: string | null): number {
  if (iso === null) return 0;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - Date.now()) / 1_000));
}
