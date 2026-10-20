import type { Config } from 'tailwindcss';
import kasuwaPreset from '@kasuwa/ui/tailwind-preset';

/**
 * Every colour, size and spacing value comes from the preset, which points at
 * the CSS variables generated from packages/ui/src/tokens.ts. Do not add raw
 * values here - the lint rule that forbids hex literals outside packages/ui
 * exists because a one-off colour is how a design system dies.
 */
const config: Config = {
  presets: [kasuwaPreset as Partial<Config>],
  // The component library styles itself with these utilities, so Tailwind has
  // to see its source (T-0128).
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/components/**/*.{ts,tsx}',
  ],
};

export default config;
