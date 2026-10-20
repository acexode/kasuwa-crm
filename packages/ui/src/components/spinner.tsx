import { cx } from './class-names';

/**
 * The v1.1 loading ring: 16px, a 2px current-colour border with one side
 * open, one turn every 800ms. Under reduced motion it holds still at 70%
 * opacity, as the export draws it ("spinners become a static ring"); the
 * global reduced-motion layer stops the turn, this dims it.
 *
 * Decorative: the control that shows it sets `aria-busy` and keeps its name.
 */
export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none motion-reduce:opacity-70',
        className,
      )}
    />
  );
}
