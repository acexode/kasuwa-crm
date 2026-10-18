'use client';

import dynamic from 'next/dynamic';

/** The record's custom values, loaded only when a definition exists to draw (PRD 2.13). */
export const LazyCustomValuesPanel = dynamic(() => import('./custom-values').then((module) => module.CustomValuesPanel), {
  loading: () => null,
});
