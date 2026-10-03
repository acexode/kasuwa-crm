#!/usr/bin/env node
/**
 * Generates `team/FEATURES.md`, the feature register (D-L36, T-0034).
 *
 *   node tools/generate-features.mjs                 write team/FEATURES.md
 *   node tools/generate-features.mjs --stdout        print the register, write nothing
 *   node tools/generate-features.mjs --check         exit 0 if team/FEATURES.md is current
 *   node tools/generate-features.mjs --check --file <path>
 *                                                    the same check against another file
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * "No feature may be quietly buried" (D-L36). A flag-gated, deferred,
 * contract-only or mock-only feature is reasonable on its own; together they
 * let a feature disappear without anyone deciding it should. The register
 * makes each of them a row with a state and the decision behind it, and CI
 * runs `--check`, so a register that has fallen behind its sources fails the
 * pull request that let it fall behind.
 *
 * WHAT IS READ, AND WHAT IS CURATED
 *
 * Read mechanically, every run:
 *   - docs/prd/M*.md                 one `module` row per PRD module
 *   - docs/api/*.openapi.yaml        one `operation` row per operation; state
 *                                    from `x-kasuwa-implemented`, screens from
 *                                    `x-kasuwa-screens`
 *   - packages/feature-flags/src/index.ts
 *                                    one `flag` row per entry of `FLAGS`; a
 *                                    screen named in a flag's description is
 *                                    behind that flag
 *   - tests/e2e/p01-auth.spec.ts, tests/e2e/p02-admin.spec.ts
 *                                    the screen manifests (`MANIFEST`)
 *   - docs/design/P02/MANIFEST.md    P02 screen names
 *   - team/DECISIONS.md              one `decision` row per DEFERRED decision
 *   - team/DECISION-LOG.md           the citation for each deferred operation
 *   - team/tasks/T-*.md              which task's Goal builds an operation
 *
 * Curated below, each entry citing where it comes from, because no source
 * states it in a form a script can read:
 *   - MODULES          the state of each PRD module beyond `not-started`
 *   - DEFERRED_OPERATIONS
 *                      the operations held back by a DEFERRED decision
 *   - SCREEN_WIRING    which screens answer from a mock or the client only
 *   - P01_SCREEN_NAMES there is no P01 manifest file to read names from
 *
 * A curated entry cannot silently outlive its reason: a deferral whose
 * decisions are no longer DEFERRED stops being `deferred`, a deferral whose
 * DECISION-LOG citation disappears is an error, and a curated id that no
 * longer exists in its source is an error. Either way the register changes or
 * the generator fails, and `--check` turns that into a red pull request.
 *
 * Output is deterministic (no timestamps, sources read in sorted order) and
 * LF-only. `.gitattributes` pins team/FEATURES.md to `eol=lf`.
 * ---------------------------------------------------------------------------
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '..');
const REGISTER = 'team/FEATURES.md';
const GENERATOR = 'tools/generate-features.mjs';
const FLAGS_SOURCE = 'packages/feature-flags/src/index.ts';
const HEADER = ['Kind', 'ID', 'Feature', 'State', 'Flag', 'Decision', 'Source'];
const STATES = ['built', 'partial', 'mock-only', 'flagged-off', 'deferred', 'not-started'];

const fromRoot = (...segments) => resolve(repoRoot, ...segments);
const read = (path) => readFileSync(fromRoot(path), 'utf8');

class GeneratorError extends Error {}

// ===========================================================================
// Curated facts. Each entry says where it comes from.
// ===========================================================================

/**
 * PRD modules whose state is something other than `not-started`. Evidence is
 * the merged work named in each note; anything not listed is not started.
 * `deferredBy` makes a module `deferred` for as long as at least one of those
 * decisions is still DEFERRED in team/DECISIONS.md.
 */
const MODULES = {
  M01: {
    state: 'partial',
    flag: 'self_serve_signup',
    decisions: ['D-P2'],
    note: 'tenancy, RLS and programme administration built; self-serve sign-up is built off (D-P2, T-0016); sales-led provisioning is T-0015',
  },
  M02: {
    state: 'partial',
    decisions: ['D-L51'],
    note: 'sign-in, MFA and sessions built (T-0001, T-0012); the permissions engine is T-0032 (D-L51)',
  },
  M03: {
    state: 'partial',
    note: 'contact read API and record view only',
  },
  M08: {
    state: 'partial',
    decisions: ['D-P10'],
    note: 'channel provider interface, fake provider and DND wrapper built (T-0017); the first real provider is D-P10; no inbox yet',
  },
  M09: {
    state: 'not-started',
    deferredBy: ['D-T1', 'D-T2', 'D-T3', 'D-T4', 'D-T5'],
    note: 'telephony integration; held back until @acexode reopens the D-T decisions (DECISION-LOG 2026-10-02, ADR-0003)',
  },
  M10: {
    state: 'partial',
    note: 'dispositions and the script list built in the admin API (T-0027); agent scripting not started',
  },
  M11: {
    state: 'not-started',
    decisions: ['D-W1', 'D-W2'],
    note: 'supervisor and QA not started; the WFM integration half is deferred (D-W1, D-W2)',
  },
  M15: {
    state: 'partial',
    note: 'metadata engine foundations (T-0002) and field-level security (T-0023, T-0026)',
  },
  M18: {
    state: 'partial',
    note: 'client-portal user invitations built (T-0030); the portal itself not started',
  },
};

/**
 * Operations held back by a DEFERRED decision rather than merely not built.
 * Source: team/DECISION-LOG.md, 2026-10-03 "the admin API goes in one wave":
 * "`getProgrammeKpis` and `getProgrammeSkillCover` stay unbuilt: their data
 * comes from the deferred telephony and WFM work (D-T*, D-W*)." The generator
 * checks that the log still names each one.
 */
const DEFERRED_OPERATIONS = {
  getProgrammeKpis: {
    decisions: ['D-T1', 'D-T2', 'D-T3', 'D-T4', 'D-T5'],
    why: 'contacts handled and handle time come from the deferred telephony integration',
  },
  getProgrammeSkillCover: {
    decisions: ['D-W1', 'D-W2'],
    why: '`needed` comes from the deferred WFM integration',
  },
};
const DEFERRAL_CITATION = 'team/DECISION-LOG.md';

/**
 * Screens that do not answer from the real API whatever their operations say.
 * First matching prefix wins.
 *   P01/5.2–5.5, P01/6: step state is client-side; there is no endpoint yet
 *     (apps/web/components/onboarding/onboarding-wizard.tsx, T-0018).
 *   P02: all 22 screens answer from the generated admin mock until T-0035
 *     moves them onto the real admin API (team/tasks/T-0035).
 */
const SCREEN_WIRING = [
  { prefix: 'P01/5.2', note: 'client-side only, no endpoint yet (T-0018)' },
  { prefix: 'P01/5.3', note: 'client-side only, no endpoint yet (T-0018)' },
  { prefix: 'P01/5.4', note: 'client-side only, no endpoint yet (T-0018)' },
  { prefix: 'P01/5.5', note: 'client-side only, no endpoint yet (T-0018)' },
  { prefix: 'P01/6', note: 'client-side only, no endpoint yet (T-0018)' },
  { prefix: 'P02/', note: 'answers from the generated admin mock until T-0035' },
];

/** P01 has no manifest file; names from the T-0007 board and tests/e2e/p01-*.spec.ts. */
const P01_SCREEN_NAMES = {
  'P01/1': 'Sign in',
  'P01/1a': 'Sign-in failed',
  'P01/1b': 'Account locked',
  'P01/1c': 'SSO domain not found',
  'P01/1d': 'Slow network',
  'P01/2': 'Two-step verification',
  'P01/2a': 'Two-step verification, switch method',
  'P01/2b': 'Two-step verification, wrong code',
  'P01/3': 'Sign up',
  'P01/4': 'Verify email or phone',
  'P01/5.1': 'Data region',
  'P01/5.2': 'Onboarding: currency',
  'P01/5.3': 'Onboarding: connect WhatsApp',
  'P01/5.4': 'Onboarding: import contacts',
  'P01/5.5': 'Onboarding: invite the team',
  'P01/6': 'Onboarding: done, setup checklist',
};

const SCREEN_SPECS = ['p01-auth.spec.ts', 'p02-admin.spec.ts'];

// ===========================================================================
// Sources
// ===========================================================================

const DECISION_ID = /\bD-[A-Z]+\d+\b/g;

function decisionIds(text) {
  return [...new Set(text.match(DECISION_ID) ?? [])];
}

/** Decisions in team/DECISIONS.md, in file order, with title and status. */
function loadDecisions() {
  const decisions = new Map();
  let current;
  for (const line of read('team/DECISIONS.md').split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(D-[A-Z]+\d+)\b\s*(?:[—-]+\s*)?(.*)$/.exec(line);
    if (heading) {
      const [, id, title] = heading;
      current = decisions.get(id) ?? { id, title: title.trim(), status: '' };
      decisions.set(id, current);
      continue;
    }
    const status = /^\*\*Status:\*\*\s*([A-Z-]+)/.exec(line);
    if (current !== undefined && status && current.status === '') {
      current.status = status[1];
    }
  }
  return decisions;
}

function loadModules() {
  return readdirSync(fromRoot('docs/prd'))
    .filter((file) => /^M\d{2}-.*\.md$/.test(file))
    .sort()
    .map((file) => {
      const id = file.slice(0, 3);
      const firstLine = read(`docs/prd/${file}`).split(/\r?\n/)[0] ?? '';
      const title = firstLine.replace(/^#\s*M\d+\.\s*/, '').trim();
      return { id, title, source: `docs/prd/${file}` };
    });
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

function loadOperations() {
  return readdirSync(fromRoot('docs/api'))
    .filter((file) => file.endsWith('.openapi.yaml'))
    .sort()
    .flatMap((file) => {
      const doc = parse(read(`docs/api/${file}`));
      return Object.entries(doc?.paths ?? {}).flatMap(([path, item]) =>
        HTTP_METHODS.filter((method) => item?.[method] && typeof item[method] === 'object').map(
          (method) => {
            const op = item[method];
            const implemented = String(op['x-kasuwa-implemented']);
            if (!['true', 'false', 'partial'].includes(implemented)) {
              throw new GeneratorError(
                `${file} ${method.toUpperCase()} ${path}: x-kasuwa-implemented is ${implemented}`,
              );
            }
            if (typeof op.operationId !== 'string' || op.operationId === '') {
              throw new GeneratorError(`${file} ${method.toUpperCase()} ${path}: no operationId`);
            }
            return {
              operationId: op.operationId,
              method: method.toUpperCase(),
              path,
              summary: typeof op.summary === 'string' ? op.summary : '',
              implemented,
              screens: Array.isArray(op['x-kasuwa-screens'])
                ? op['x-kasuwa-screens'].map(String)
                : [],
              file: `docs/api/${file}`,
            };
          },
        ),
      );
    });
}

/** Strips comments from TypeScript source without touching string contents. */
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function unquote(literal) {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '`' && body.includes('${')) {
    throw new GeneratorError(`${FLAGS_SOURCE}: template interpolation in a flag field`);
  }
  return body.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

/**
 * The `FLAGS` registry, read from its source text. This script is plain Node
 * and cannot import TypeScript; the registry is a literal by design (a unit
 * test pins it), so reading the literal is exact. Anything it cannot read is
 * an error, never a silently missing row.
 */
function loadFlags() {
  const source = stripComments(read(FLAGS_SOURCE));
  const start = source.search(/export const FLAGS\s*=\s*\{/);
  if (start === -1) throw new GeneratorError(`${FLAGS_SOURCE}: no \`export const FLAGS = {\``);
  const open = source.indexOf('{', start);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) throw new GeneratorError(`${FLAGS_SOURCE}: FLAGS literal is not closed`);
  const body = source.slice(open + 1, close);

  const STRING = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\]|\\.)*\`)`;
  const flags = [];
  const entry = /(?:^|,)\s*(?:'([\w-]+)'|"([\w-]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{([^{}]*)\}/g;
  let consumed = 0;
  for (const match of body.matchAll(entry)) {
    const name = match[1] ?? match[2] ?? match[3];
    const fields = match[4];
    const field = (key, pattern) => {
      const found = new RegExp(`\\b${key}\\s*:\\s*${pattern}`).exec(fields);
      if (!found) throw new GeneratorError(`${FLAGS_SOURCE}: flag ${name} has no readable ${key}`);
      return found[1];
    };
    flags.push({
      name,
      description: unquote(field('description', STRING)),
      defaultValue: field('defaultValue', '(true|false)\\b') === 'true',
      owner: unquote(field('owner', STRING)),
    });
    consumed += 1;
  }
  const leftover = body.replace(entry, '').trim().replace(/^,|,$/g, '').trim();
  if (consumed === 0 || leftover !== '') {
    throw new GeneratorError(
      `${FLAGS_SOURCE}: could not read every entry of FLAGS (read ${consumed}; unread: ${leftover.slice(0, 80)})`,
    );
  }
  return flags;
}

/** The `MANIFEST = { built: [...], notBuilt: [...] }` constant of an e2e spec. */
function loadScreenManifest(spec) {
  const text = read(`tests/e2e/${spec}`);
  const block = /const MANIFEST = \{([\s\S]*?)\n\}/.exec(text)?.[1];
  if (block === undefined) throw new GeneratorError(`tests/e2e/${spec}: no MANIFEST constant`);
  const list = (key) => {
    const body = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(block)?.[1] ?? '';
    return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  };
  return { spec: `tests/e2e/${spec}`, built: list('built'), notBuilt: list('notBuilt') };
}

function loadP02ScreenNames() {
  const names = {};
  for (const line of read('docs/design/P02/MANIFEST.md').split(/\r?\n/)) {
    const row = /^\|\s*`(P02\/[\w.]+)`\s*\|\s*`[^`]*`\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (row) names[row[1]] = row[2];
  }
  return names;
}

/** For each operationId, the tasks whose `## Goal` section names it in backticks. */
function loadTaskAttribution(operationIds) {
  const byOperation = new Map(operationIds.map((id) => [id, []]));
  const files = readdirSync(fromRoot('team/tasks'))
    .filter((file) => /^T-\d{4}-.*\.md$/.test(file))
    .sort();
  for (const file of files) {
    const text = read(`team/tasks/${file}`);
    const goal = /^## Goal\s*$([\s\S]*?)(?=^## )/m.exec(text)?.[1] ?? '';
    for (const id of operationIds) {
      if (goal.includes(`\`${id}\``)) byOperation.get(id).push(file.slice(0, 6));
    }
  }
  return byOperation;
}

// ===========================================================================
// Rows
// ===========================================================================

function buildRows() {
  const decisions = loadDecisions();
  const isDeferred = (id) => decisions.get(id)?.status === 'DEFERRED';
  const deferredList = [...decisions.values()].filter((d) => d.status === 'DEFERRED');

  const modules = loadModules();
  const operations = loadOperations();
  const flags = loadFlags();
  const manifests = SCREEN_SPECS.map(loadScreenManifest);
  const p02Names = loadP02ScreenNames();
  const tasksFor = loadTaskAttribution(operations.map((op) => op.operationId));
  const decisionLog = read(DEFERRAL_CITATION);

  // Curated ids must still exist in their sources.
  const moduleIds = new Set(modules.map((m) => m.id));
  for (const id of Object.keys(MODULES)) {
    if (!moduleIds.has(id)) throw new GeneratorError(`MODULES names ${id}, which has no PRD file`);
  }
  const operationIds = new Set(operations.map((op) => op.operationId));
  for (const [id, deferral] of Object.entries(DEFERRED_OPERATIONS)) {
    if (!operationIds.has(id)) {
      throw new GeneratorError(`DEFERRED_OPERATIONS names ${id}, which is in no OpenAPI spec`);
    }
    if (!decisionLog.includes(`\`${id}\``)) {
      throw new GeneratorError(
        `DEFERRED_OPERATIONS names ${id}, but ${DEFERRAL_CITATION} no longer does; the deferral has lost its citation`,
      );
    }
    for (const decision of deferral.decisions) {
      if (!decisions.has(decision)) {
        throw new GeneratorError(
          `DEFERRED_OPERATIONS cites ${decision}, which is not in DECISIONS.md`,
        );
      }
    }
  }

  const rows = [];

  // --- flags, first, because screens and operations inherit from them -------
  const flagFor = new Map(); // screen id -> flag
  const flagRows = flags.map((flag) => {
    const gated = flag.description.match(/\bP\d{2}\/[\w.]+/g) ?? [];
    for (const screen of gated) flagFor.set(screen.replace(/\.$/, ''), flag);
    return {
      kind: 'flag',
      id: flag.name,
      feature: flag.description,
      state: flag.defaultValue ? 'built' : 'flagged-off',
      flag: flag.name,
      decision: decisionIds(flag.owner),
      source: FLAGS_SOURCE,
    };
  });

  // --- operations -----------------------------------------------------------
  const operationState = new Map();
  const operationDecisions = new Map();
  const operationRows = operations.map((op) => {
    const deferral = DEFERRED_OPERATIONS[op.operationId];
    const stillDeferred = deferral ? deferral.decisions.filter(isDeferred) : [];
    let state;
    if (op.implemented === 'true') state = 'built';
    else if (op.implemented === 'partial') state = 'partial';
    else state = stillDeferred.length > 0 ? 'deferred' : 'not-started';

    const gatingFlags = [...new Set(op.screens.map((s) => flagFor.get(s)?.name))];
    const flag =
      op.screens.length > 0 && gatingFlags.length === 1 && gatingFlags[0] !== undefined
        ? flags.find((f) => f.name === gatingFlags[0])
        : undefined;

    const opDecisions = [
      ...(state === 'deferred' ? stillDeferred : []),
      ...(flag ? decisionIds(flag.owner) : []),
    ];
    operationState.set(op.operationId, state);
    operationDecisions.set(op.operationId, opDecisions);

    const note =
      state === 'deferred'
        ? ` (deferred: ${deferral.why})`
        : op.implemented === 'false'
          ? ' (contract only)'
          : '';
    const tasks = tasksFor.get(op.operationId);
    return {
      kind: 'operation',
      id: op.operationId,
      feature: `${op.method} ${op.path} — ${op.summary}${note}`,
      state,
      flag: flag?.name ?? '',
      decision: opDecisions,
      source: [op.file, ...(state === 'deferred' ? [DEFERRAL_CITATION] : []), ...tasks].join(' · '),
    };
  });

  // --- screens --------------------------------------------------------------
  const backing = new Map();
  for (const op of operations) {
    for (const screen of op.screens) backing.set(screen, [...(backing.get(screen) ?? []), op]);
  }
  const screenRows = manifests.flatMap((manifest) =>
    [...manifest.built, ...manifest.notBuilt].map((screen) => {
      const ops = backing.get(screen) ?? [];
      const states = ops.map((op) => operationState.get(op.operationId));
      const flag = flagFor.get(screen);
      const wiring = SCREEN_WIRING.find((w) => screen.startsWith(w.prefix));
      const notBuilt = manifest.notBuilt.includes(screen);

      const backendState = (() => {
        if (states.length === 0) return 'built';
        if (states.every((s) => s === 'built')) return 'built';
        if (states.every((s) => s === 'deferred')) return 'deferred';
        if (states.every((s) => s === 'not-started' || s === 'deferred')) return 'mock-only';
        return 'partial';
      })();

      let state;
      if (flag && !flag.defaultValue) state = 'flagged-off';
      else if (notBuilt) state = 'not-started';
      else if (wiring) state = 'mock-only';
      else state = backendState;

      const builtCount = states.filter((s) => s === 'built').length;
      const held = ops
        .filter((op) => operationState.get(op.operationId) !== 'built')
        .map((op) => `${op.operationId} ${operationState.get(op.operationId)}`);
      const backend =
        ops.length === 0
          ? 'no operation in docs/api'
          : `${builtCount} of ${ops.length} operations built${held.length ? `; ${held.join(', ')}` : ''}`;
      const name = screen.startsWith('P02/') ? p02Names[screen] : P01_SCREEN_NAMES[screen];
      const notes = [backend, ...(wiring ? [wiring.note] : [])];

      return {
        kind: 'screen',
        id: screen,
        feature: `${name ?? screen} — ${notes.join('; ')}`,
        state,
        flag: flag?.name ?? '',
        decision: [
          ...(flag ? decisionIds(flag.owner) : []),
          ...ops.flatMap((op) => operationDecisions.get(op.operationId)),
        ],
        source: manifest.spec,
      };
    }),
  );

  // --- modules --------------------------------------------------------------
  const moduleRows = modules.map((module) => {
    const curated = MODULES[module.id] ?? {};
    const stillDeferred = (curated.deferredBy ?? []).filter(isDeferred);
    const state = stillDeferred.length > 0 ? 'deferred' : (curated.state ?? 'not-started');
    return {
      kind: 'module',
      id: module.id,
      feature: curated.note ? `${module.title} — ${curated.note}` : module.title,
      state,
      flag: curated.flag ?? '',
      decision: [...stillDeferred, ...(curated.decisions ?? [])],
      source: module.source,
    };
  });

  // --- deferred decisions ---------------------------------------------------
  const decisionRows = deferredList.map((decision) => ({
    kind: 'decision',
    id: decision.id,
    feature: decision.title,
    state: 'deferred',
    flag: '',
    decision: [decision.id],
    source: 'team/DECISIONS.md',
  }));

  rows.push(
    { title: 'Modules', intro: 'One row per PRD module (`docs/prd/`).', rows: moduleRows },
    {
      title: 'Screens',
      intro:
        'Every screen in the P01 and P02 e2e manifests. A screen never claims more than its backend: one answering from a mock is `mock-only`, one behind an off flag is `flagged-off`.',
      rows: screenRows,
    },
    {
      title: 'Operations',
      intro:
        'Every operation in `docs/api/*.openapi.yaml`, its state from `x-kasuwa-implemented` (true: built, partial: partial, false: not-started, or deferred when a DEFERRED decision holds it back).',
      rows: operationRows,
    },
    { title: 'Flags', intro: 'Every entry of `FLAGS` in `@kasuwa/feature-flags`.', rows: flagRows },
    {
      title: 'Deferred decisions',
      intro: 'Every decision whose status in `team/DECISIONS.md` is DEFERRED.',
      rows: decisionRows,
    },
  );
  return rows;
}

// ===========================================================================
// Rendering
// ===========================================================================

function cell(value) {
  const text = Array.isArray(value) ? [...new Set(value)].join(', ') : String(value);
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return flat === '' ? '—' : flat;
}

function tick(value) {
  return value === '' ? '—' : `\`${value}\``;
}

function render(sections) {
  const all = sections.flatMap((s) => s.rows);
  for (const row of all) {
    if (!STATES.includes(row.state))
      throw new GeneratorError(`${row.kind} ${row.id}: state ${row.state}`);
  }
  const counts = STATES.map((state) => `${state} ${all.filter((r) => r.state === state).length}`);

  const lines = [
    '<!--',
    `  GENERATED by ${GENERATOR} from the PRD, the OpenAPI specs, the flag`,
    '  registry, the e2e screen manifests, the task files and team/DECISIONS.md.',
    '  Do not edit by hand: run `pnpm features` and commit the result.',
    '  CI runs `pnpm features:check` and fails when this file is stale.',
    '-->',
    '',
    '# Feature register',
    '',
    'No feature may be quietly buried (D-L36). Every PRD module, screen, API operation,',
    'feature flag and deferred decision has a row with its state and the decision behind it.',
    '',
    `States: ${STATES.map((s) => `\`${s}\``).join(', ')}.`,
    '',
    `Totals: ${all.length} rows; ${counts.join(', ')}.`,
  ];

  for (const section of sections) {
    lines.push('', `## ${section.title}`, '', section.intro, '');
    lines.push(`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`);
    for (const row of section.rows) {
      lines.push(
        `| ${[
          row.kind,
          tick(row.id),
          cell(row.feature),
          row.state,
          tick(row.flag),
          cell(row.decision),
          cell(row.source),
        ].join(' | ')} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ===========================================================================
// --check
// ===========================================================================

function rowKeys(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/^`(.*)`$/, '$1'));
    if (cells.length < 2 || cells[0] === 'Kind' || /^-+$/.test(cells[0])) continue;
    map.set(`${cells[0]} ${cells[1]}`, trimmed);
  }
  return map;
}

function describeDrift(expected, actual) {
  const problems = [];
  if (actual.includes('\r'))
    problems.push('the file has CRLF line endings; the register is LF-only');
  const want = rowKeys(expected);
  const have = rowKeys(actual);
  for (const [key, line] of want) {
    if (!have.has(key)) problems.push(`missing row: ${key}`);
    else if (have.get(key) !== line)
      problems.push(`changed row: ${key}\n      expected ${line}\n      found    ${have.get(key)}`);
  }
  for (const key of have.keys()) if (!want.has(key)) problems.push(`row with no source: ${key}`);
  if (problems.length === 0) {
    const a = expected.split('\n');
    const b = actual.split('\n');
    const at = a.findIndex((line, i) => line !== b[i]);
    problems.push(
      `text outside the tables differs (first at line ${(at === -1 ? a.length : at) + 1})`,
    );
  }
  return problems;
}

// ===========================================================================

function main(argv) {
  const args = new Set(argv);
  const fileIndex = argv.indexOf('--file');
  const target = fileIndex === -1 ? fromRoot(REGISTER) : resolve(argv[fileIndex + 1] ?? '');
  if (fileIndex !== -1 && argv[fileIndex + 1] === undefined) {
    throw new GeneratorError('--file needs a path');
  }

  const output = render(buildRows());

  if (args.has('--stdout')) {
    process.stdout.write(output);
    return 0;
  }
  if (args.has('--check')) {
    const rel = relative(repoRoot, target).replace(/\\/g, '/');
    const shown = rel === '' || rel.startsWith('..') ? target : rel;
    if (!existsSync(target)) {
      console.error(`${shown} does not exist. Run \`pnpm features\` and commit the result.`);
      return 1;
    }
    const actual = readFileSync(target, 'utf8');
    if (actual === output) {
      console.log(`${shown} is current.`);
      return 0;
    }
    console.error(`${shown} is stale (D-L36). Run \`pnpm features\` and commit the result.`);
    for (const problem of describeDrift(output, actual)) console.error(`  - ${problem}`);
    return 1;
  }
  writeFileSync(target, output, 'utf8');
  console.log(`wrote ${relative(repoRoot, target).replace(/\\/g, '/')}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof GeneratorError) {
    console.error(`generate-features: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
