import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nx from '@nx/eslint-plugin';
import i18next from 'eslint-plugin-i18next';

/**
 * Conventions are executable, not prose (Addendum A1 section 3.5: "convention
 * drift across hundreds of PRs" is mitigated by lint rules and hooks, not by
 * documents nobody rereads).
 *
 * Every rule below encodes a decision recorded elsewhere:
 *   - module boundaries      -> founding pack 3.16, ADR-0001
 *   - no-explicit-any        -> founding pack 3.17
 *   - no raw hex outside ui  -> D-L10, so the design system stays the only
 *                               source of colour
 *   - no process.env outside @kasuwa/config -> so environment parsing stays at
 *                               one validated boundary
 *   - no @kasuwa/testing in app code -> the isolation harness can forge RLS
 *                               session variables; it must never be reachable
 *                               from a running process
 *   - no literal strings in apps/web -> PRD 2.9/2.13 require every string
 *                               externalised for nine locales and RTL
 */

const ENV_SELECTOR = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message:
    'Read configuration through @kasuwa/config, which validates the environment with Zod at one boundary.',
};

const HEX_SELECTOR = {
  selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/]',
  message:
    'Colour literals belong in packages/ui/src/tokens.ts. Use a semantic token or a scale step.',
};

/**
 * The migrator connection string (kasuwa_migrator, BYPASSRLS) is for operator
 * commands only: migrate, seed, tenant provisioning (D-L07, D-L54). An app
 * process that reads it has an unscoped connection to every tenant. Matched by
 * name in every form a read can take: `env().DATABASE_MIGRATION_URL`,
 * `env()['DATABASE_MIGRATION_URL']` and `const { DATABASE_MIGRATION_URL } = env()`.
 */
const MIGRATION_URL_MESSAGE =
  'DATABASE_MIGRATION_URL is the kasuwa_migrator (BYPASSRLS) connection. Only operator commands (migrate, seed, tenant:provision) may read it; no app process.';
const MIGRATION_URL_SELECTORS = [
  {
    selector: "MemberExpression[property.name='DATABASE_MIGRATION_URL']",
    message: MIGRATION_URL_MESSAGE,
  },
  {
    selector: "MemberExpression[property.value='DATABASE_MIGRATION_URL']",
    message: MIGRATION_URL_MESSAGE,
  },
  {
    selector: "ObjectPattern > Property[key.name='DATABASE_MIGRATION_URL']",
    message: MIGRATION_URL_MESSAGE,
  },
];

const BOUNDARY_CONSTRAINTS = [
  {
    // Domain modules may reach shared infrastructure and the external-system
    // adapters, and NOTHING of another domain. Cross-domain collaboration goes
    // through published interfaces or events, never an internal import.
    sourceTag: 'scope:domain',
    onlyDependOnLibsWithTags: ['scope:shared', 'scope:adapter'],
  },
  {
    // Adapters wrap external systems (telephony, WFM). They know nothing about
    // Kasuwa's domains, which is what keeps them swappable.
    sourceTag: 'scope:adapter',
    onlyDependOnLibsWithTags: ['scope:shared'],
  },
  {
    sourceTag: 'scope:shared',
    onlyDependOnLibsWithTags: ['scope:shared'],
  },
  {
    sourceTag: 'scope:ui',
    onlyDependOnLibsWithTags: ['scope:ui', 'scope:shared'],
  },
  {
    // Apps compose; they are the only place allowed to see everything at once.
    sourceTag: 'scope:app',
    onlyDependOnLibsWithTags: ['scope:shared', 'scope:domain', 'scope:adapter', 'scope:ui'],
  },
  {
    // The test harness needs the database layer to build fixtures and to forge
    // RLS session variables. Nothing tagged scope:testing may be imported by a
    // runtime package - no constraint above lists it, which is what enforces
    // that, and tools/verify-boundaries.mjs proves it still does.
    sourceTag: 'scope:testing',
    onlyDependOnLibsWithTags: ['scope:shared'],
  },
  {
    // The acceptance suite is allowed to reach anywhere, including the
    // isolation harness. It is the only tag that may.
    sourceTag: 'scope:test',
    onlyDependOnLibsWithTags: ['*'],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.nx/**',
      'packages/ui/src/*.generated.css',
      'apps/web/public/fonts/**',
      'tools/fixtures/**',
      // Playwright's output: traces, the bundled HTML report and screenshots.
      // Git-ignored, machine-written, and large enough that linting it takes
      // longer than linting the workspace.
      'tests/e2e/.artifacts/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: false,
          allow: [],
          depConstraints: BOUNDARY_CONSTRAINTS,
        },
      ],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',

      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@kasuwa/testing',
              message:
                'The isolation harness can forge RLS session variables. It belongs in tests only.',
            },
          ],
        },
      ],
    },
  },

  {
    // The channel fakes are exported from the adapter's main entry because the
    // T-0017 acceptance suite loads them from there. Runtime code must never
    // send through a fake (or a fake DND register that clears every number),
    // so apps and domains may not import them. `no-restricted-imports` is one
    // rule: this block replaces the one above for these paths, so it restates
    // the @kasuwa/testing ban. Tests are exempted by the block further down.
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@kasuwa/testing',
              message:
                'The isolation harness can forge RLS session variables. It belongs in tests only.',
            },
            {
              name: '@kasuwa/channel-adapter',
              importNames: ['FakeChannelProvider', 'FakeDndRegister'],
              message:
                'The channel fakes send nothing and clear every DND lookup. They belong in tests only.',
            },
          ],
        },
      ],
    },
  },

  {
    // Tenant provisioning (T-0015) runs on the migrator connection and is an
    // operator command. It is exported from @kasuwa/domain-core's main entry
    // only because the T-0015 acceptance suite loads it from there, so app
    // code is banned from importing it by name. This block replaces the one
    // above for apps/**, so it restates both of that block's entries.
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@kasuwa/testing',
              message:
                'The isolation harness can forge RLS session variables. It belongs in tests only.',
            },
            {
              name: '@kasuwa/channel-adapter',
              importNames: ['FakeChannelProvider', 'FakeDndRegister'],
              message:
                'The channel fakes send nothing and clear every DND lookup. They belong in tests only.',
            },
            {
              name: '@kasuwa/domain-core',
              importNames: ['provisionTenant'],
              message:
                'provisionTenant runs on the kasuwa_migrator (BYPASSRLS) connection. It is an operator command (pnpm tenant:provision), never reachable from an app process (D-L54).',
            },
          ],
          patterns: [
            {
              group: ['@kasuwa/domain-core/*'],
              message:
                'Import @kasuwa/domain-core from its main entry. Operator-only code must not be reachable from apps.',
            },
          ],
        },
      ],
    },
  },

  // --- restricted syntax -------------------------------------------------
  // One block, because `no-restricted-syntax` is a single rule: a later config
  // object replaces its whole configuration rather than adding to it. The two
  // exemptions below therefore re-state the selector they still want.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ENV_SELECTOR, HEX_SELECTOR],
    },
  },
  {
    // @kasuwa/config is the one place that may read process.env - it is the
    // validated boundary everything else goes through.
    files: ['packages/config/**/*.ts', 'tools/**', '**/*.config.ts', '**/*.config.mjs'],
    rules: { 'no-restricted-syntax': ['error', HEX_SELECTOR] },
  },
  {
    // packages/ui is the one place that may contain colour literals - it is the
    // design system, and every other module reads tokens from it.
    files: ['packages/ui/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ENV_SELECTOR] },
  },
  {
    // No app process may read the migrator connection string (D-L07, D-L54).
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ENV_SELECTOR, HEX_SELECTOR, ...MIGRATION_URL_SELECTORS],
    },
  },

  // --- no hard-coded user-facing strings in the web app --------------------
  {
    files: ['apps/web/**/*.tsx'],
    plugins: { i18next },
    rules: {
      // jsx-text-only: flags visible text nodes. Attribute values (className,
      // aria-*, href) are excluded because flagging them produces enough noise
      // that people disable the rule, which is worse than a narrower rule that
      // stays on. Extending coverage to user-facing attributes is Agent 11's
      // call once there are real screens.
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
    },
  },

  // --- tests may do things application code may not ------------------------
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'packages/testing/**', 'tests/**'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- tooling scripts are plain node --------------------------------------
  {
    files: [
      'tools/**/*.mjs',
      '**/scripts/**/*.mjs',
      '**/*.config.mjs',
      '.claude/hooks/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { 'no-console': 'off', 'no-undef': 'off' },
  },

  // --- generated files are not hand-maintained -----------------------------
  {
    files: ['**/*.generated.ts', 'packages/ui/tailwind-preset.cjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
