'use client';

import { serverLazy } from '../../lib/client-lazy';
import { quiet } from './lazy-boundary';

/** The custom filters of a list, loaded only when a picklist or boolean definition exists (PRD 2.13). */
const Bar = serverLazy(() => import('./custom-filters').then((module) => module.CustomFilterBar));

export const LazyCustomFilterBar = quiet(Bar);
