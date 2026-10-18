'use client';

import dynamic from 'next/dynamic';
import { quiet } from './lazy-boundary';

/** The record's custom values, loaded only when a definition exists to draw (PRD 2.13). */
const Panel = dynamic(() => import('./custom-values').then((module) => module.CustomValuesPanel), {
  loading: () => null,
});

export const LazyCustomValuesPanel = quiet(Panel);
