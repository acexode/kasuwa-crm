'use client';

import { Suspense, lazy, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

/**
 * A component fetched the first time it is drawn, in the browser only: what
 * `next/dynamic` with `ssr: false` does, without `next/dynamic` (T-0145).
 *
 * `next/dynamic` ships its own loader on every page that uses it (its
 * loadable, chunk preloading and server bail-out modules, about 2 KB
 * gzipped), and every use here is a sheet, a dialog, a view or a flagged panel
 * that is drawn after the page is up, which React's own `lazy` covers. The
 * shell already loads the palette and the bell this way.
 *
 * The same behaviour as before, step by step: the server renders `loading`
 * (or nothing), hydration renders it too, so the markup matches, and once the
 * page is interactive the component loads and replaces it. A fetch that fails
 * throws to the nearest error boundary, as `next/dynamic` does.
 */
export function clientLazy<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: { readonly loading?: () => ReactNode } = {},
): ComponentType<P> {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  const loading = options.loading;
  function ClientLazy(props: P) {
    const inBrowser = useSyncExternalStore(subscribeToNothing, isBrowser, isServer);
    const fallback = loading === undefined ? null : loading();
    if (!inBrowser) return fallback;
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return ClientLazy;
}

/**
 * A component fetched the first time it is drawn, rendered on the server too:
 * `next/dynamic` with its default `ssr: true`, without `next/dynamic`. The
 * server renders it in full; the browser fetches its code to hydrate it, and
 * draws nothing in its place until then where it renders it fresh.
 */
export function serverLazy<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  function ServerLazy(props: P) {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return ServerLazy;
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

function isBrowser(): boolean {
  return true;
}

function isServer(): boolean {
  return false;
}
