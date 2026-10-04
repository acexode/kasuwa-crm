import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../src/locales/en.json';
import { pseudoCatalogue } from '../src/pseudo';

/**
 * Generates the `en-XA` pseudo-locale from `en`.
 *
 * Two transformations, each catching a different bug:
 *   1. accent every vowel  -> any string still reading as plain English in the
 *      UI was never externalised
 *   2. pad to ~140% length -> layouts that only fit English break visibly here
 *      rather than in production in French or Swahili
 *
 * The transform lives in `src/pseudo.ts`, shared with the runtime, which
 * derives the same catalogue on first use of `?locale=en-XA` (T-0042). This
 * file is for inspecting it on disk.
 */

const catalogue = pseudoCatalogue(en);

const target = resolve(__dirname, '..', 'src', 'locales', 'en-XA.json');
writeFileSync(target, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
process.stdout.write(`wrote ${Object.keys(catalogue).length} pseudo messages to ${target}\n`);
