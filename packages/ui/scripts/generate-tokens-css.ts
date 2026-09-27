import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTokensCss } from '../src/css';
import { buildTailwindPreset } from '../src/preset';

/**
 * Emits the two generated artefacts consumed by apps: the CSS custom
 * properties and the Tailwind preset. CI reruns this and fails on any diff, so
 * neither can drift from packages/ui/src/tokens.ts.
 */
const targets: [string, string][] = [
  [resolve(__dirname, '..', 'src', 'tokens.generated.css'), buildTokensCss()],
  [resolve(__dirname, '..', 'tailwind-preset.cjs'), buildTailwindPreset()],
];

for (const [path, contents] of targets) {
  writeFileSync(path, contents, 'utf8');
  process.stdout.write('wrote ' + path + '\n');
}
