import type { Layout } from './home-model';

/**
 * Ordering rules for the Home layout round trips (T-0159 review fixes). Pure,
 * so each rule is tested without a component.
 */

export type LayoutOp = { readonly kind: 'save'; readonly layout: Layout } | { readonly kind: 'clear' };

/**
 * Serialises writes so the last edit always wins: one write in flight, and
 * while it is, only the latest pending operation is kept (earlier ones are
 * superseded, not sent late). `run` must not throw; a throw is swallowed so
 * the chain never stalls.
 */
export function createLayoutWriter(run: (op: LayoutOp) => Promise<void>): (op: LayoutOp) => void {
  let pending: LayoutOp | null = null;
  let running = false;
  const drain = async (): Promise<void> => {
    running = true;
    try {
      while (pending !== null) {
        const op = pending;
        pending = null;
        try {
          await run(op);
        } catch {
          // The layout lasts for this visit; the next edit tries again.
        }
      }
    } finally {
      running = false;
    }
  };
  return (op) => {
    pending = op;
    if (!running) void drain();
  };
}

/** A late read result is applied only if the person has not edited since the read began. */
export function shouldApplyLoad(edited: boolean, current: boolean, saved: Layout | null): saved is Layout {
  return !edited && current && saved !== null;
}
