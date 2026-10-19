import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A SERVER COMPONENT MAY NOT IMPORT A VALUE FROM A `'use client'` MODULE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS, WRITTEN THE DAY AFTER IT WAS NEEDED
 *
 * It is a 500 in a browser that typechecks and lints cleanly, which is the
 * worst combination there is. A client module's exports become CLIENT
 * REFERENCES: a server component that imports a component from one gets a
 * placeholder React knows how to render, and that is the supported pattern.
 * A server component that imports an ARRAY from one gets a proxy object, and
 * spreading or iterating it fails at REQUEST time — "ids is not iterable" —
 * with nothing at compile time to warn you. It cost a full e2e run on P01 and
 * `components/admin/message-ids.ts` carries a comment begging nobody to add
 * `'use client'` to it.
 *
 * The rule enforced here is the cheap version of that, and it is enough:
 * **a server page may import from a client module only bindings it then uses
 * as JSX.** `<ProgrammesScreen …>` is fine. `ADMIN_PROGRAMMES_MESSAGE_IDS`
 * imported from a client module is not, and that is exactly the failure.
 *
 * It reads source rather than rendering anything, because rendering an App
 * Router page needs a request, a router and a fetch, and none of that is the
 * bug.
 * ---------------------------------------------------------------------------
 */

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = here;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = resolve(directory, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

function isClientModule(file: string): boolean {
  try {
    return /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Resolves a relative specifier to the `.ts`/`.tsx` file it names. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, resolve(base, 'index.tsx'), resolve(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension.
    }
  }
  return null;
}

const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']*)'/g;

describe('the server/client boundary', () => {
  const serverComponents = walk(appRoot).filter((file) => !isClientModule(file));

  it('finds the server components to check', () => {
    expect(serverComponents.length).toBeGreaterThan(0);
  });

  for (const file of serverComponents) {
    const relative = file.slice(appRoot.length + 1).replace(/\\/g, '/');

    it(`${relative} imports only JSX from client modules`, () => {
      const source = readFileSync(file, 'utf8');
      const offences: string[] = [];

      for (const match of source.matchAll(IMPORT)) {
        const [statement, names = '', specifier = ''] = match;
        // A type-only import is erased before it reaches the runtime.
        if (statement.includes('import type')) continue;

        const target = resolveLocal(file, specifier);
        if (target === null || !isClientModule(target)) continue;

        for (const raw of names.split(',')) {
          const binding = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '';
          if (binding === '' || raw.trim().startsWith('type ')) continue;
          // Used as JSX — the supported pattern, and the only one.
          if (new RegExp(`<${binding}[\\s/>]`).test(source)) continue;
          offences.push(`${binding} from ${specifier}`);
        }
      }

      expect(
        offences,
        `${relative} imports a value (not a component) from a 'use client' module. ` +
          'That becomes a client reference and fails at request time, not at compile time.',
      ).toEqual([]);
    });
  }
});

/**
 * NO BROWSER CODE REACHES `lib/server/` (ADR-0019 step c, T-0125).
 *
 * `lib/server/` holds the BFF: the cookie, the CSRF check, the header policy
 * and the upstream address. None of it may be bundled for a browser. A
 * `'use client'` module, or anything a client module imports, that reaches
 * into `lib/server/` would ship it, so this walks every client module's
 * relative imports transitively and fails on the first path into it. (Next
 * would also refuse a `node:` import in a client bundle, but only at build
 * time and only for some of what lives there.)
 */
const webRoot = resolve(here, '..');
const serverRoot = resolve(webRoot, 'lib', 'server');

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = resolve(directory, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' || entry.startsWith('.') ? [] : sources(full);
    return /\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

const ANY_IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?'(\.[^']*)'|import\(\s*'(\.[^']*)'\s*\)/g;

function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(ANY_IMPORT)) {
    if (match[0].includes('import type') || match[0].includes('export type')) continue;
    const target = resolveLocal(file, match[1] ?? match[2] ?? '');
    if (target !== null) found.push(target);
  }
  return found;
}

describe('the browser never reaches lib/server', () => {
  const clientModules = ['app', 'components', 'lib'].flatMap((directory) => sources(resolve(webRoot, directory))).filter(isClientModule);

  it('finds client modules to check', () => {
    expect(clientModules.length).toBeGreaterThan(0);
  });

  it('no lib/server module is itself a client module', () => {
    expect(sources(serverRoot).filter(isClientModule)).toEqual([]);
  });

  it('no client module imports lib/server, directly or through anything it imports', () => {
    const offences: string[] = [];
    const seen = new Set<string>();
    const queue = clientModules.map((file) => ({ file, from: file }));
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next.file)) continue;
      seen.add(next.file);
      if (next.file.startsWith(`${serverRoot}/`) || next.file.startsWith(`${serverRoot}\\`)) {
        offences.push(`${next.from.slice(webRoot.length + 1)} reaches ${next.file.slice(webRoot.length + 1)}`);
        continue;
      }
      for (const target of localImports(next.file)) queue.push({ file: target, from: next.from });
    }
    expect(offences).toEqual([]);
  });
});
