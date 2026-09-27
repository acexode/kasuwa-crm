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
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
};

export default config;
