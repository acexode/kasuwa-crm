'use client';


import { AUTH_COLUMN } from './auth-classes';

/**
 * `P01/1d` — the slow-network state.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SPINNER, AND IT IS NOT DECORATION.
 *
 * It is the 256 kbps NFR (PRD 2.13) made visible: a skeleton while the request
 * is young, a plain sentence at four seconds saying the network is slow, and an
 * OFFER — a lighter page — rather than an apology. A spinner tells a person on
 * a 2G connection something they already know and gives them nothing to do.
 *
 * It is also the screen most likely to be cut for time, because nothing breaks
 * when it is missing; the failure is invisible from an office on fibre. The
 * task file says in as many words not to cut it, and an acceptance test checks
 * that a spec exercises `P01/1d` under the low-bandwidth profile.
 * ---------------------------------------------------------------------------
 *
 * The skeleton is `aria-hidden` and the status message carries the text,
 * because six grey rectangles announced one by one is worse than silence.
 * `motion-reduce:animate-none` honours `prefers-reduced-motion` at the only
 * place this screen animates anything.
 */
export function SlowConnection({
  title,
  body,
  switchLabel,
  keepWaitingLabel,
  skeletonLabel,
  onSwitch,
  onKeepWaiting,
}: {
  title: string;
  body: string;
  switchLabel: string;
  keepWaitingLabel: string;
  skeletonLabel: string;
  onSwitch: () => void;
  onKeepWaiting: () => void;
}) {
  return (
    <section data-screen="P01/1d" className={AUTH_COLUMN}>
      <span className="sr-only">{skeletonLabel}</span>
      <div
        role="status"
        data-testid="still-connecting"
        className="flex flex-col gap-2.5 rounded-10 bg-info-soft p-3.5 text-body-sm text-info-text"
      >
        <p className="flex items-center gap-2.5 font-bold">
          <span
            aria-hidden="true"
            className="inline-block size-4.5 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none"
          />
          {title}
        </p>
        <p className="text-text-2">{body}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="switch-to-lite"
            onClick={onSwitch}
            className="h-control-base rounded-md bg-primary px-3.5 text-body-sm font-semibold text-on-primary hover:bg-primary-hover focus-visible:ring-focus"
          >
            {switchLabel}
          </button>
          <button
            type="button"
            onClick={onKeepWaiting}
            className="h-control-base rounded-md px-3 text-body-sm font-semibold text-primary-text hover:bg-primary-soft focus-visible:ring-focus"
          >
            {keepWaitingLabel}
          </button>
        </div>
      </div>

      <div aria-hidden="true" className="flex flex-col gap-3.5">
        <span className="h-7 w-8/12 rounded-6 bg-surface-sunken" />
        <span className="h-3.5 w-7/12 rounded-sm bg-surface-sunken" />
        <span className="h-control-lg rounded-md bg-surface-sunken" />
        <span className="h-control-lg rounded-md bg-surface-sunken" />
        <span className="h-control-lg rounded-md bg-surface-sunken" />
        <span className="h-control-lg rounded-md bg-surface-sunken opacity-70" />
      </div>
    </section>
  );
}
