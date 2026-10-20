import { describe, expect, it } from 'vitest';
import { rovingTarget, tabStopIndex } from './roving';

const NONE = [false, false, false, false];
const LTR_TABS = { rtl: false, orientation: 'horizontal' } as const;
const LTR_RADIO = { rtl: false, orientation: 'both' } as const;
const RTL_TABS = { rtl: true, orientation: 'horizontal' } as const;

describe('rovingTarget: arrow keys inside a tab list or radio group', () => {
  it('moves right to the next item and left to the previous one', () => {
    expect(rovingTarget('ArrowRight', 1, NONE, LTR_TABS)).toBe(2);
    expect(rovingTarget('ArrowLeft', 1, NONE, LTR_TABS)).toBe(0);
  });

  it('wraps at both ends', () => {
    expect(rovingTarget('ArrowRight', 3, NONE, LTR_TABS)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, NONE, LTR_TABS)).toBe(3);
  });

  it('skips disabled items, wrapping past them', () => {
    const disabled = [false, true, false, true];
    expect(rovingTarget('ArrowRight', 0, disabled, LTR_TABS)).toBe(2);
    expect(rovingTarget('ArrowRight', 2, disabled, LTR_TABS)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, disabled, LTR_TABS)).toBe(2);
  });

  it('goes to the first and last enabled item on Home and End', () => {
    const disabled = [true, false, false, true];
    expect(rovingTarget('Home', 2, disabled, LTR_TABS)).toBe(1);
    expect(rovingTarget('End', 1, disabled, LTR_TABS)).toBe(2);
  });

  it('swaps left and right in a right-to-left layout', () => {
    // In Arabic the next tab is to the LEFT, and the left arrow goes there.
    expect(rovingTarget('ArrowLeft', 1, NONE, RTL_TABS)).toBe(2);
    expect(rovingTarget('ArrowRight', 1, NONE, RTL_TABS)).toBe(0);
    expect(rovingTarget('Home', 2, NONE, RTL_TABS)).toBe(0);
  });

  it('answers up and down in a radio group only', () => {
    expect(rovingTarget('ArrowDown', 1, NONE, LTR_RADIO)).toBe(2);
    expect(rovingTarget('ArrowUp', 1, NONE, LTR_RADIO)).toBe(0);
    // A horizontal tab list leaves Down to the page, so it can scroll.
    expect(rovingTarget('ArrowDown', 1, NONE, LTR_TABS)).toBeNull();
    expect(rovingTarget('ArrowUp', 1, NONE, LTR_TABS)).toBeNull();
  });

  it('leaves every other key alone, so Tab, Enter and Space keep their meaning', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageDown']) {
      expect(rovingTarget(key, 1, NONE, LTR_RADIO), key).toBeNull();
    }
  });

  it('goes nowhere when every item is disabled or there are none', () => {
    expect(rovingTarget('ArrowRight', 0, [true, true], LTR_TABS)).toBeNull();
    expect(rovingTarget('Home', 0, [], LTR_TABS)).toBeNull();
  });
});

describe('tabStopIndex: the one item in the tab order', () => {
  it('is the selected item', () => {
    expect(tabStopIndex(2, NONE)).toBe(2);
  });

  it('is the first enabled item when nothing is selected or the selection is disabled', () => {
    expect(tabStopIndex(-1, NONE)).toBe(0);
    expect(tabStopIndex(0, [true, false, false])).toBe(1);
    expect(tabStopIndex(9, [true, false])).toBe(1);
  });

  it('is nothing when every item is disabled', () => {
    expect(tabStopIndex(0, [true, true])).toBeNull();
  });
});
