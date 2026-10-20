import { describe, expect, it } from 'vitest';
import { focusables } from './overlay';

/** Just enough of an element for the trap: its tab index and whether it is drawn. */
function element(name: string, tabIndex: number, drawn = true): HTMLElement {
  return { name, tabIndex, getClientRects: () => ({ length: drawn ? 1 : 0 }) } as unknown as HTMLElement;
}

function rootOf(...elements: HTMLElement[]): HTMLElement {
  return { querySelectorAll: () => elements } as unknown as HTMLElement;
}

describe('focusables: the modal overlay focus trap’s tab stops', () => {
  it('skips a link or control with tabindex -1, so the trap wraps from the real last stop (D-L137 M2)', () => {
    // The command palette: its input, its close button, then option links reached by the arrow keys.
    const input = element('input', 0);
    const close = element('close', 0);
    const option = element('option link', -1);
    expect(focusables(rootOf(input, close, option))).toEqual([input, close]);
  });

  it('keeps positive tab indexes and drops what is not drawn', () => {
    const first = element('first', 0);
    const hidden = element('hidden', 0, false);
    const ordered = element('ordered', 2);
    expect(focusables(rootOf(first, hidden, ordered))).toEqual([first, ordered]);
  });
});
