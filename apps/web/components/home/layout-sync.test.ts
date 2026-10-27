import { describe, expect, it } from 'vitest';
import { createLayoutWriter, shouldApplyLoad, type LayoutOp } from './layout-sync';
import type { Layout } from './home-model';

const A: Layout = [{ type: 'nba', span: 12 }];
const B: Layout = [{ type: 'agenda', span: 6 }];
const C: Layout = [{ type: 'agenda', span: 4 }];

describe('createLayoutWriter', () => {
  it('sends one write at a time and the last edit lands last, even if earlier ones are slower', async () => {
    const started: LayoutOp[] = [];
    const finished: LayoutOp[] = [];
    let release: () => void = () => undefined;
    const write = createLayoutWriter(async (op) => {
      started.push(op);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished.push(op);
    });
    write({ kind: 'save', layout: A });
    write({ kind: 'save', layout: B });
    write({ kind: 'save', layout: C });
    expect(started).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([
      { kind: 'save', layout: A },
      { kind: 'save', layout: C },
    ]);
    expect(finished.at(-1)).toEqual({ kind: 'save', layout: C });
  });

  it('keeps a reset in order and keeps going after a failure', async () => {
    const seen: string[] = [];
    const write = createLayoutWriter(async (op) => {
      seen.push(op.kind);
      if (seen.length === 1) throw new Error('boom');
    });
    write({ kind: 'save', layout: A });
    write({ kind: 'clear' });
    await new Promise((r) => setTimeout(r, 0));
    write({ kind: 'save', layout: B });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['save', 'clear', 'save']);
  });
});

describe('shouldApplyLoad', () => {
  it('ignores a late read once the person has edited', () => {
    expect(shouldApplyLoad(true, true, A)).toBe(false);
  });
  it('applies a read nobody has edited over, and ignores null or stale effects', () => {
    expect(shouldApplyLoad(false, true, A)).toBe(true);
    expect(shouldApplyLoad(false, true, null)).toBe(false);
    expect(shouldApplyLoad(false, false, A)).toBe(false);
  });
});
