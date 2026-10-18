'use client';

import dynamic from 'next/dynamic';

/** The custom filters of a list, loaded only when a picklist or boolean definition exists (PRD 2.13). */
export const LazyCustomFilterBar = dynamic(() => import('./custom-filters').then((module) => module.CustomFilterBar), {
  loading: () => null,
});
