'use client';

import { serverLazy } from '../../lib/client-lazy';
import { quiet } from './lazy-boundary';

/** The record's custom values, loaded only when a definition exists to draw (PRD 2.13). */
const Panel = serverLazy(() => import('./custom-values').then((module) => module.CustomValuesPanel));

export const LazyCustomValuesPanel = quiet(Panel);
