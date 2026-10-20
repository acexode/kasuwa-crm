'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders an overlay into its own element at the end of <body>, marked
 * `data-k-portal`, so a modal can make every sibling `inert` without making
 * itself inert. Nothing renders on the server: an overlay is opened by a
 * user, never painted in the first HTML.
 */
export function Portal({ children }: { readonly children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const element = document.createElement('div');
    element.setAttribute('data-k-portal', '');
    document.body.appendChild(element);
    setHost(element);
    return () => {
      element.remove();
    };
  }, []);

  return host === null ? null : createPortal(children, host);
}
