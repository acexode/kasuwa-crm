import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildTokensCss } from '../src/css';

const target = resolve(__dirname, '..', 'src', 'tokens.css');
writeFileSync(target, buildTokensCss(), 'utf8');
process.stdout.write('wrote ' + target + '\n');
