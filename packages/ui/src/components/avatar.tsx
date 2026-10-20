import type { ComponentPropsWithRef } from 'react';
import { avatarTone, initials, type AvatarTone } from './avatar-identity';
import { cx } from './class-names';
import { Glyph } from './glyph';

export type AvatarSize = 44 | 32;
export type AvatarPresence = 'available' | 'offline';

const TONE: Record<AvatarTone, string> = {
  primary: 'bg-primary-soft-strong text-primary-text',
  accent: 'bg-accent-soft text-accent-text',
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
};

const OFFLINE = 'bg-surface-sunken text-text-muted';

const SIZE: Record<AvatarSize, string> = {
  // 44: the record header and presence avatar. 14/700 initials.
  44: 'size-touch text-body-sm font-bold',
  // 32: list rows (P04). 12/700 initials.
  32: 'size-8 text-caption font-bold',
};

export interface AvatarProps extends Omit<ComponentPropsWithRef<'span'>, 'children'> {
  /** The person's display name. The initials come from it. */
  readonly name: string;
  /**
   * What picks the colour. Pass a stable id where there is one, so a rename
   * does not recolour the person; the name is used otherwise.
   */
  readonly seed?: string;
  readonly size?: AvatarSize;
  /**
   * Presence, as a shape as well as a colour (v1.1: "Each presence has a
   * unique shape/glyph, not just a colour"): available is a filled success
   * dot ringed in surface; offline is a hollow border-strong ring, and the
   * whole avatar goes surface-sunken in text-muted.
   */
  readonly presence?: AvatarPresence;
  /**
   * The accessible name, presence included ("Kemi Adeyemi, available"). Left
   * out, the avatar is decorative: right for a row that already shows the name.
   */
  readonly label?: string;
  /** For locale-correct uppercasing of the initials. */
  readonly locale?: string;
}

/**
 * An initials avatar (v1.1 "Avatars & presence"): round, 44 or 32px, the
 * initials on one of four soft fills picked by a hash of the seed, so the
 * same person is the same colour everywhere. No photos on the first build:
 * "photos only when low-bandwidth mode is off".
 *
 * A name with no letters at all falls back to the `person` glyph.
 */
export function Avatar({
  name,
  seed,
  size = 44,
  presence,
  label,
  locale,
  className,
  ...rest
}: AvatarProps) {
  const letters = initials(name, locale);
  return (
    <span
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cx(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-full',
        SIZE[size],
        // Offline greys the whole avatar, as v1.1 draws "AD · Offline".
        presence === 'offline' ? OFFLINE : TONE[avatarTone(seed ?? name)],
        className,
      )}
      {...rest}
    >
      {letters === '' ? <Glyph name="person" size={size === 44 ? 22 : 18} /> : letters}
      {presence === 'available' ? (
        <span className="absolute -bottom-px -end-px size-3.5 rounded-full bg-success ring-2 ring-surface" />
      ) : null}
      {presence === 'offline' ? (
        // The export draws a surface dot inside a 3px border-strong ring. A
        // border-strong disc around an 8px surface disc is the same picture
        // without a 3px border width the scale does not have.
        <span className="absolute -bottom-px -end-px flex size-3.5 items-center justify-center rounded-full bg-border-strong">
          <span className="size-2 rounded-full bg-surface" />
        </span>
      ) : null}
    </span>
  );
}
