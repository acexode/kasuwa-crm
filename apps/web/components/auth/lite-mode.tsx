'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../icon';
import { LITE_COOKIE } from '../../lib/lite-cookie';

/**
 * Low-bandwidth ("lite") mode.
 *
 * Not a cosmetic preference. On 256 kbps with 300 ms of latency — the network
 * PRD 2.13 commits to — the difference between the full sign-in page and the
 * lite one is the difference between a form appearing and a user giving up. So
 * the state lives above every auth screen, persists in a cookie the server can
 * read on the next request, and is offered explicitly by `P01/1d` rather than
 * buried in a settings page the person never reaches.
 */


interface LiteModeValue {
  readonly lite: boolean;
  readonly setLite: (value: boolean) => void;
}

const LiteModeContext = createContext<LiteModeValue | undefined>(undefined);

export function LiteModeProvider({
  initial,
  children,
}: {
  initial: boolean;
  children: ReactNode;
}) {
  const [lite, setLiteState] = useState(initial);

  const setLite = useCallback((value: boolean) => {
    setLiteState(value);
    document.cookie = `${LITE_COOKIE}=${value ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const value = useMemo(() => ({ lite, setLite }), [lite, setLite]);
  return <LiteModeContext.Provider value={value}>{children}</LiteModeContext.Provider>;
}

export function useLiteMode(): LiteModeValue {
  const value = useContext(LiteModeContext);
  if (value === undefined) {
    throw new Error('useLiteMode must be used inside a LiteModeProvider');
  }
  return value;
}

/**
 * The top-bar switch. `role="switch"` with `aria-checked`, because this turns a
 * thing on and off rather than navigating anywhere, and a screen-reader user
 * needs to know which state it is in before pressing it.
 */
export function LiteModeToggle({
  label,
  onLabel,
  accessibleName,
  compact,
}: {
  label: string;
  onLabel: string;
  accessibleName: string;
  /**
   * Icon only. `'phone'` is icon only below `md` and labelled above it, as
   * the P01 top bar draws it at 360 and at 1440 (T-0131).
   */
  compact: boolean | 'phone';
}) {
  const { lite, setLite } = useLiteMode();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={lite}
      aria-label={accessibleName}
      data-testid="lite-mode-toggle"
      onClick={() => setLite(!lite)}
      className={`inline-flex h-control-base min-w-touch shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-meta font-semibold focus-visible:ring-focus ${
        lite
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border bg-surface text-text hover:bg-surface-sunken'
      }`}
    >
      <Icon name="network_check" size={20} />
      {compact === true ? null : (
        <span className={compact === 'phone' ? 'hidden md:inline' : undefined}>{lite ? onLabel : label}</span>
      )}
    </button>
  );
}
