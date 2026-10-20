'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { initials } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { useLiteMode } from '../auth/lite-mode';

/**
 * Pieces both shells draw (T-0130), to the P03/P04 and P02/P18 top bars.
 * Tokens only: every size is a T-0127 utility (`h-shell-header`,
 * `size-control-sm`, `text-icon-22`, `rounded-10`).
 */

/** Focus for shell controls: the v1.1 ring (a 2px surface gap, then a 2px focus ring). */
export const SHELL_FOCUS = 'outline-none focus-visible:ring-focus';

/**
 * The 32px logo tile (radius 8, the letter at 17/800 accent on primary) and the
 * "Kasuwa" wordmark at 16/700. `href` null draws it without a link (a link to a
 * 404 is worse than none).
 */
export function Brand({
  t,
  href,
  wordmark = true,
  children,
}: {
  t: Translator;
  href: string | null;
  wordmark?: boolean;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-logo text-accent"
      >
        {t.t('app.name').slice(0, 1)}
      </span>
      <b className={wordmark ? 'text-card-title' : 'sr-only'}>{t.t('app.name')}</b>
      {children}
    </>
  );
  const className = `flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md ${SHELL_FOCUS}`;
  return href === null ? (
    <span className={className}>{inner}</span>
  ) : (
    <Link href={href} className={className}>
      {inner}
    </Link>
  );
}

/**
 * The labelled top-bar switch for low-bandwidth mode (P03 header): 44px, 0 10px,
 * radius 8, 13/600, a 20px `network_check`. Off is bordered surface; on is
 * accent-soft with an accent edge and reads "Lite mode on".
 */
export function ShellLiteToggle({
  t,
  className,
  compact = false,
}: {
  t: Translator;
  className?: string;
  /** Icon only, as the phone app bar draws it (P03 at 360); the switch keeps its name. */
  compact?: boolean;
}) {
  const { lite, setLite } = useLiteMode();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={lite}
      aria-label={t.t('auth.topbar.lite.toggle')}
      data-testid="lite-mode-toggle"
      onClick={() => setLite(!lite)}
      className={`inline-flex h-control-base min-w-touch shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-meta font-semibold transition-colors duration-instant ${SHELL_FOCUS} ${
        lite
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border bg-surface text-text is-hover:bg-surface-sunken'
      } ${className ?? ''}`}
    >
      <Icon name="network_check" size={20} />
      <span className={compact ? 'sr-only' : undefined}>{t.t(lite ? 'auth.topbar.lite.on' : 'auth.topbar.lite')}</span>
    </button>
  );
}

/**
 * The 36px header avatar: accent-soft, initials 13/700. Until the name is known
 * (or if it never arrives) a person glyph, never invented initials.
 */
export function ShellAvatar({ name, locale }: { name: string | null; locale: string }) {
  const letters = name === null ? '' : initials(name, locale);
  return (
    <span
      aria-hidden="true"
      className="flex size-control-sm shrink-0 items-center justify-center rounded-full bg-accent-soft text-meta font-bold text-accent-text"
    >
      {letters === '' ? <Icon name="person" size={20} /> : letters}
    </span>
  );
}
