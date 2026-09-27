import {
  COLOUR_SCALES,
  CSS_VAR_PREFIX,
  FONT_FAMILIES,
  RADIUS,
  SEMANTIC_DARK,
  SEMANTIC_LIGHT,
  SPACING,
  TYPE_SCALE,
  type ColourFamily,
  type ToneKey,
} from './tokens';

/**
 * Renders the tokens as CSS custom properties.
 *
 * `packages/ui/src/tokens.css` is generated from this and committed; CI runs
 * `pnpm ui:tokens` and fails if the working tree changes, so the file can never
 * drift from tokens.ts. Do not hand-edit tokens.css.
 */

function block(selectorOrAtRule: string, declarations: string[]): string {
  return `${selectorOrAtRule} {\n${declarations.map((line) => `  ${line}`).join('\n')}\n}`;
}

export function buildTokensCss(): string {
  const scaleDeclarations: string[] = [];
  for (const [family, scale] of Object.entries(COLOUR_SCALES)) {
    for (const [tone, value] of Object.entries(scale)) {
      scaleDeclarations.push(
        `${CSS_VAR_PREFIX}-${family as ColourFamily}-${tone as ToneKey}: ${value};`,
      );
    }
  }

  const typeDeclarations = Object.entries(TYPE_SCALE).flatMap(([step, spec]) => [
    `${CSS_VAR_PREFIX}-font-size-${step}: ${spec.size};`,
    `${CSS_VAR_PREFIX}-line-height-${step}: ${spec.lineHeight};`,
    `${CSS_VAR_PREFIX}-font-weight-${step}: ${spec.weight};`,
    `${CSS_VAR_PREFIX}-tracking-${step}: ${spec.tracking};`,
  ]);

  const familyDeclarations = Object.entries(FONT_FAMILIES).map(
    ([name, stack]) => `${CSS_VAR_PREFIX}-font-${name}: ${stack};`,
  );

  const spacingDeclarations = Object.entries(SPACING).map(
    ([name, value]) => `${CSS_VAR_PREFIX}-space-${name}: ${value};`,
  );

  const radiusDeclarations = Object.entries(RADIUS).map(
    ([name, value]) => `${CSS_VAR_PREFIX}-radius-${name}: ${value};`,
  );

  const lightDeclarations = Object.entries(SEMANTIC_LIGHT).map(
    ([token, value]) => `${CSS_VAR_PREFIX}-${token}: ${value};`,
  );
  const darkDeclarations = Object.entries(SEMANTIC_DARK).map(
    ([token, value]) => `${CSS_VAR_PREFIX}-${token}: ${value};`,
  );

  return [
    '/* GENERATED FILE — do not edit. Source: packages/ui/src/tokens.ts */',
    '/* Regenerate with: pnpm ui:tokens */',
    '',
    block(':root', [
      ...scaleDeclarations,
      '',
      ...familyDeclarations,
      ...typeDeclarations,
      ...spacingDeclarations,
      ...radiusDeclarations,
      '',
      '/* semantic tokens — light theme is the default */',
      ...lightDeclarations,
    ]),
    '',
    '/* Explicit opt-in, so a tenant or user preference can pin a theme. */',
    block('[data-theme="dark"]', darkDeclarations),
    '',
    '/* System preference, unless an explicit light theme is pinned. */',
    block('@media (prefers-color-scheme: dark)', [
      block(':root:not([data-theme="light"])', darkDeclarations).split('\n').join('\n  '),
    ]),
    '',
  ].join('\n');
}
