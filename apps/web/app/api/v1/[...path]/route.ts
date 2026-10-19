import { bffConfig, bffDependencies } from '../../../../lib/server/bff-config';
import { createBffHandler } from '../../../../lib/server/bff-forward';

/**
 * `/api/v1/*` — the browser's only door to the API (ADR-0019 point 1,
 * T-0125). It replaces the `/api/v1` rewrite that used to sit in
 * `next.config.mjs`. Everything it does is in `lib/server/bff-forward.ts`;
 * this file only binds it to every method.
 *
 * Node runtime (the default; never edge), and never cached or prerendered:
 * every answer belongs to one session.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handle = createBffHandler(bffConfig, bffDependencies);

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
