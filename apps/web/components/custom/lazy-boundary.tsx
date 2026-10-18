'use client';

import { Component, type ComponentType, type ReactNode } from 'react';
import type { Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { QUIET_BUTTON } from '../auth/button-classes';

/**
 * A lazy region that failed to load (a chunk lost to a dropped connection, the
 * normal weather at 256 kbps) must never take the record or the list down with
 * it (C9). The value panel and the filter bar show nothing; a sheet or a form
 * says the screen's own "could not connect" copy and offers a retry, and the
 * record stays where it was.
 */
interface Props {
  /** Present for a sheet or a form: the retry copy. Absent: the region shows nothing when it fails. */
  readonly t?: Translator;
  readonly children: ReactNode;
}

export class LazyBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { t } = this.props;
    if (t === undefined) return null;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-md bg-danger-soft p-3 text-body-sm text-danger-text">
        <p className="flex items-start gap-2">
          <Icon name="error" size="sm" />
          {t.t('records.error.network')}
        </p>
        <button type="button" onClick={() => this.setState({ failed: false })} className={QUIET_BUTTON}>
          {t.t('records.retry')}
        </button>
      </div>
    );
  }
}

/** A sheet or a form that loads when opened: on failure, the retry copy, with the record left alone. */
export function guarded<P extends { readonly t: Translator }>(Inner: ComponentType<P>): ComponentType<P> {
  return function Guarded(props: P) {
    return (
      <LazyBoundary t={props.t}>
        <Inner {...props} />
      </LazyBoundary>
    );
  };
}

/** A region that is only a convenience (the value panel, the filter bar): nothing on failure. */
export function quiet<P extends object>(Inner: ComponentType<P>): ComponentType<P> {
  return function Quiet(props: P) {
    return (
      <LazyBoundary>
        <Inner {...props} />
      </LazyBoundary>
    );
  };
}
