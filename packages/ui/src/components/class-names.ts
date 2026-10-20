/**
 * Joins class names, dropping the falsy ones. Every class string in this
 * directory is a literal somewhere in the source, so Tailwind's scanner sees
 * it; this only decides which of them apply.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

/**
 * `data-*` attributes a caller can put on an element a component renders for
 * it: an option, the label, a status icon. The /design/components gallery
 * uses them to mark the element a test measures (`data-gallery`); nothing can
 * restyle a control through them.
 */
export type DataAttributes = { readonly [key: `data-${string}`]: string | undefined };
