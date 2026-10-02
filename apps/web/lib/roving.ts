/**
 * Arrow-key movement for a radio group or a tab list (WAI-ARIA APG): one tab
 * stop for the whole group, arrows move between options and wrap, Home and
 * End jump. Left and Right swap under `dir="rtl"`, because "next" is to the
 * left there — RTL is a layout mode, and that includes the keyboard.
 *
 * Returns `null` for a key the group does not handle, so Tab still leaves.
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  direction: 'ltr' | 'rtl' = 'ltr',
): number | null {
  if (count <= 0) return null;
  const forward = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backward = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case forward:
    case 'ArrowDown':
      return (current + 1) % count;
    case backward:
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The direction an element is laid out in, read from the document. */
export function directionOf(element: Element | null): 'ltr' | 'rtl' {
  return element?.closest('[dir]')?.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';
}
