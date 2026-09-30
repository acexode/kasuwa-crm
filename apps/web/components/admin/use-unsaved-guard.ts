'use client';

import { useEffect } from 'react';

/**
 * "Leaving the page asks first" (`P02/B4`, `P02/D2`).
 *
 * ---------------------------------------------------------------------------
 * WHY A CAPTURE-PHASE CLICK LISTENER AND NOT A ROUTER HOOK.
 *
 * The App Router has no navigation-guard API: `useRouter` gives no `beforeRoute`
 * event, and the `popstate` hook fires after the URL has already changed. The
 * links a person can leave by are ordinary anchors — the settings menu, the
 * breadcrumb, the tab strip — so the guard sits where those clicks pass, in the
 * capture phase on `document`, before Next's own handler sees them.
 *
 * `beforeUnload` covers the other half: a reload, a closed tab, a typed URL.
 * The browser shows its own wording there and that is correct — a page cannot
 * be trusted to render its own dialog while it is being torn down.
 *
 * The guard is OFF when nothing is dirty. A confirmation people see when they
 * have changed nothing is a confirmation they learn to click through, and then
 * it does not protect the one time it mattered.
 * ---------------------------------------------------------------------------
 */
export function useUnsavedGuard(
  dirty: boolean,
  onIntercept: (destination: string) => void,
): void {
  useEffect(() => {
    if (!dirty) return undefined;

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href') ?? '';
      // A same-page fragment is not leaving the page.
      if (href === '' || href.startsWith('#')) return;
      if (anchor.href === window.location.href) return;

      event.preventDefault();
      event.stopPropagation();
      onIntercept(href);
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required by Chrome to show the native prompt. The string is never
      // displayed, so it is not a user-facing message and needs no catalogue
      // key; every browser substitutes its own wording.
      event.returnValue = '';
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty, onIntercept]);
}
