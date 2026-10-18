'use client';

import dynamic from 'next/dynamic';
import { quiet } from './lazy-boundary';

/** The custom filters of a list, loaded only when a picklist or boolean definition exists (PRD 2.13). */
const Bar = dynamic(() => import('./custom-filters').then((module) => module.CustomFilterBar), {
  loading: () => null,
});

export const LazyCustomFilterBar = quiet(Bar);
