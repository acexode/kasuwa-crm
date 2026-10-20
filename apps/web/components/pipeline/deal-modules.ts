import type { DealModules } from '../../lib/feature-flags';

export type { DealModules };

/** Every P06 placeholder off: what a screen draws when its server page passes none (D-L194). */
export const NO_MODULES: DealModules = {
  fxDisplay: false,
  summary: false,
  templates: false,
  whatsapp: false,
  products: false,
  risk: false,
  relationships: false,
  quotes: false,
};
