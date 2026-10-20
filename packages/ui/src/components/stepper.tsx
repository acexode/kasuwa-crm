import type { ReactNode } from 'react';
import { cx } from './class-names';
import { Glyph } from './glyph';

/**
 * The stepper, to the P28 import export (v1.1 vocabulary): a wrapping row of
 * 26px circles, each with its label inline and a 24×2 hairline connector to
 * the next.
 *
 *   done    a solid success circle with a 16px on-primary check; label 13/500
 *           in text-2.
 *   active  a solid primary circle with its number in on-primary 12/700;
 *           label 13/700 in text, and `aria-current="step"`.
 *   todo    a surface circle with a 1px border-strong edge and its number in
 *           text-2; label 13/500 in text-2.
 *
 * On a phone (`compactBelow="sm"`) the row collapses to one line, "Step 3 of
 * 5 · Clean up" (the caller's string), over a 4px progress bar, so five
 * labels never wrap into a column.
 */

export type StepState = 'done' | 'active' | 'todo';

export interface StepperStep {
  readonly label: ReactNode;
  readonly state: StepState;
}

export interface StepperProps {
  readonly steps: readonly StepperStep[];
  /** The list's accessible name ("Steps"). */
  readonly label: string;
  /**
   * The phone's one-line summary ("Step 3 of 5 · Clean up"). Given, it
   * replaces the row below 640px.
   */
  readonly compactSummary?: ReactNode | undefined;
  readonly className?: string | undefined;
}

const CIRCLE: Record<StepState, string> = {
  done: 'bg-success text-on-primary',
  active: 'bg-primary text-on-primary',
  todo: 'border border-border-strong bg-surface text-text-2',
};

function isActive(step: StepperStep): boolean {
  return step.state === 'active';
}

function isDone(step: StepperStep): boolean {
  return step.state === 'done';
}

export function Stepper({ steps, label, compactSummary, className }: StepperProps) {
  const active = steps.findIndex(isActive);
  const done = steps.filter(isDone).length;
  const progress = steps.length === 0 ? 0 : ((active === -1 ? done : active + 1) / steps.length) * 100;
  const compact = compactSummary !== undefined;

  return (
    <div className={className}>
      <ol
        aria-label={label}
        className={cx(
          'm-0 flex list-none flex-wrap items-center gap-x-2.5 gap-y-1.5 p-0',
          compact && 'max-sm:hidden',
        )}
      >
        {steps.map((step, index) => (
          <li
            // Steps are a fixed sequence; their order is their identity.
            key={index}
            aria-current={step.state === 'active' ? 'step' : undefined}
            className="flex items-center gap-2"
          >
            <span
              className={cx(
                'flex size-6.5 shrink-0 items-center justify-center rounded-full text-caption font-bold',
                CIRCLE[step.state],
              )}
            >
              {step.state === 'done' ? <Glyph name="check" size={16} /> : index + 1}
            </span>
            <span
              className={cx(
                'whitespace-nowrap text-meta',
                step.state === 'active' ? 'font-bold text-text' : 'font-medium text-text-2',
              )}
            >
              {step.label}
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="h-0.5 w-6 rounded-sm bg-border" />
            ) : null}
          </li>
        ))}
      </ol>
      {compact ? (
        <div className="hidden flex-col gap-2 max-sm:flex">
          <span className="text-meta font-bold text-text">{compactSummary}</span>
          <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
