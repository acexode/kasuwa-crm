import {
  ARABIC_LINE_HEIGHT_MULTIPLIER,
  COLOUR_SCALES,
  CONTROL_HEIGHT,
  CSS_VAR_PREFIX,
  cssKey,
  DESIGN_VERSION,
  ELEVATION,
  FONT_FAMILIES,
  FONT_WEIGHTS,
  ICON_SIZE,
  MOTION,
  MOTION_EASING,
  RADIUS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SHELL,
  SPACING,
  TYPE_SCALE,
} from './tokens';

/**
 * Renders the design tokens as CSS custom properties.
 *
 * `packages/ui/src/tokens.generated.css` is produced from this and committed;
 * CI regenerates and fails on any diff, so the CSS cannot drift from the
 * TypeScript. Do not hand-edit the CSS.
 *
 * Three things in here are load-bearing beyond "emit some variables":
 *
 *   1. Theme selection. Dark applies on an explicit `data-theme="dark"`, and on
 *      the system preference unless light is explicitly pinned. Tenants get a
 *      theme choice, and a user's OS preference should win when they have not
 *      made one.
 *   2. Arabic line-height. Arabic script sits taller at the same point size, so
 *      `[lang="ar"]` scales line-heights by 10% per the export.
 *   3. Reduced motion. Emitted as a global layer rather than left to each
 *      component, because "remember to respect prefers-reduced-motion" is a
 *      convention that gets forgotten exactly once and then ships.
 */

function block(selector: string, declarations: string[], indent = ''): string {
  const body = declarations.map((line) => `${indent}  ${line}`).join('\n');
  return `${indent}${selector} {\n${body}\n${indent}}`;
}

function semanticDeclarations(tokens: Record<string, string>): string[] {
  return Object.entries(tokens).map(([name, value]) => `${CSS_VAR_PREFIX}-${name}: ${value};`);
}

function scaleDeclarations(): string[] {
  const declarations: string[] = [];
  for (const [family, scale] of Object.entries(COLOUR_SCALES)) {
    for (const [tone, value] of Object.entries(scale)) {
      declarations.push(`${CSS_VAR_PREFIX}-scale-${family}-${tone}: ${value};`);
    }
  }
  return declarations;
}

function typeDeclarations(): string[] {
  const declarations: string[] = [];
  for (const [step, spec] of Object.entries(TYPE_SCALE)) {
    declarations.push(`${CSS_VAR_PREFIX}-font-size-${step}: ${spec.size};`);
    declarations.push(`${CSS_VAR_PREFIX}-line-height-${step}: ${spec.lineHeight};`);
    declarations.push(`${CSS_VAR_PREFIX}-font-weight-${step}: ${spec.weight};`);
    declarations.push(`${CSS_VAR_PREFIX}-tracking-${step}: ${spec.tracking};`);
  }
  return declarations;
}

export function buildTokensCss(): string {
  const light = semanticDeclarations(SEMANTIC_LIGHT);
  const dark = semanticDeclarations(SEMANTIC_DARK);

  const rootDeclarations = [
    '/* colour scales */',
    ...scaleDeclarations(),
    '',
    '/* typography */',
    ...Object.entries(FONT_FAMILIES).map(
      ([name, stack]) => `${CSS_VAR_PREFIX}-font-${name}: ${stack};`,
    ),
    ...Object.entries(FONT_WEIGHTS).map(
      ([name, weight]) => `${CSS_VAR_PREFIX}-weight-${name}: ${weight};`,
    ),
    ...typeDeclarations(),
    '',
    '/* spacing, radius */',
    ...Object.entries(SPACING).map(
      ([name, value]) => `${CSS_VAR_PREFIX}-space-${cssKey(name)}: ${value};`,
    ),
    ...Object.entries(RADIUS).map(
      ([name, value]) => `${CSS_VAR_PREFIX}-radius-${cssKey(name)}: ${value};`,
    ),
    '',
    '/* control heights, icon sizes, app shell */',
    ...Object.entries(CONTROL_HEIGHT).map(
      ([name, value]) => `${CSS_VAR_PREFIX}-control-height-${cssKey(name)}: ${value};`,
    ),
    ...Object.entries(ICON_SIZE).map(
      ([name, value]) => `${CSS_VAR_PREFIX}-icon-size-${cssKey(name)}: ${value};`,
    ),
    ...Object.entries(SHELL).map(
      ([name, value]) => `${CSS_VAR_PREFIX}-shell-${cssKey(name)}: ${value};`,
    ),
    '',
    '/* elevation — the shadow values themselves are semantic, so they differ per theme */',
    ...Object.entries(ELEVATION).map(
      ([level, spec]) => `${CSS_VAR_PREFIX}-elevation-${level}: ${spec.shadow};`,
    ),
    '',
    '/* motion */',
    ...Object.entries(MOTION).map(
      ([name, spec]) => `${CSS_VAR_PREFIX}-duration-${name}: ${spec.duration};`,
    ),
    `${CSS_VAR_PREFIX}-ease: ${MOTION_EASING};`,
    '',
    '/* semantic tokens — light is the default theme */',
    ...light,
  ];

  return [
    `/* GENERATED FILE — do not edit. Source: packages/ui/src/tokens.ts (Design ${DESIGN_VERSION}) */`,
    '/* Regenerate with: pnpm ui:tokens */',
    '',
    block(':root', rootDeclarations),
    '',
    '/* Explicit opt-in, so a tenant or a user preference can pin a theme. */',
    block('[data-theme="dark"]', dark),
    '',
    '/* System preference, unless light has been explicitly pinned. */',
    '@media (prefers-color-scheme: dark) {',
    block(':root:not([data-theme="light"])', dark, '  '),
    '}',
    '',
    '/*',
    ' * Arabic script sits taller at the same point size. The export specifies',
    ' * +10% line-height for it.',
    ' */',
    block('[lang="ar"], [dir="rtl"][lang="ar"]', [
      `${CSS_VAR_PREFIX}-font-sans: ${FONT_FAMILIES.arabic};`,
      ...Object.entries(TYPE_SCALE).map(([step, spec]) => {
        const scaled = Math.round(
          Number.parseFloat(spec.lineHeight) * ARABIC_LINE_HEIGHT_MULTIPLIER,
        );
        return `${CSS_VAR_PREFIX}-line-height-${step}: ${scaled}px;`;
      }),
    ]),
    '',
    '/*',
    ' * Reduced motion, as a global layer.',
    ' *',
    ' * Per the export: slides and scales become a one-frame opacity fade,',
    ' * spinners become a static ring, skeleton shimmer stops, and the Kanban',
    ' * drag tilt is dropped.',
    ' *',
    ' * SLA countdowns and timers are NOT covered here and must keep running:',
    ' * they are information, not decoration, and a supervisor watching a',
    ' * breach needs the number to move. They update via script rather than CSS',
    ' * animation, so this layer does not touch them — keep it that way.',
    ' */',
    '@media (prefers-reduced-motion: reduce) {',
    block(
      '*, *::before, *::after',
      [
        'animation-duration: 1ms !important;',
        'animation-iteration-count: 1 !important;',
        'transition-duration: 1ms !important;',
        'scroll-behavior: auto !important;',
      ],
      '  ',
    ),
    '',
    block(
      '[data-k-shimmer]',
      ['animation: none !important;', 'background-image: none !important;'],
      '  ',
    ),
    '',
    block('[data-k-drag]', ['transform: none !important;'], '  '),
    '}',
    '',
  ].join('\n');
}
