import { describe, expect, it } from 'vitest';
import { inertOutside, type InertNode } from './inert-outside';

function el(tagName: string, children: InertNode[] = [], attributes: string[] = []): InertNode & { attrs: Set<string> } {
  const attrs = new Set(attributes);
  const node = {
    tagName,
    parentElement: null as InertNode | null,
    children,
    attrs,
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
  for (const child of children) (child as { parentElement: InertNode | null }).parentElement = node;
  return node;
}

describe('inertOutside (N13)', () => {
  it('makes every sibling up the tree inert but the kept node and its ancestors, and undoes only its own', () => {
    const keep = el('DIV');
    const bellButton = el('BUTTON');
    const root = el('DIV', [bellButton, keep]);
    const search = el('A');
    const header = el('HEADER', [search, root]);
    const nav = el('NAV');
    const main = el('MAIN', [], ['inert']);
    const script = el('SCRIPT');
    const shell = el('DIV', [header, nav, main, script]);
    const announcer = el('NEXT-ROUTE-ANNOUNCER');
    const body = el('BODY', [shell, announcer]);
    void body;

    const undo = inertOutside(keep);
    expect([bellButton, search, nav, main].map((node) => node.hasAttribute('inert'))).toEqual([true, true, true, true]);
    expect([keep, root, header, shell, script, announcer].map((node) => node.hasAttribute('inert'))).toEqual([false, false, false, false, false, false]);

    undo();
    expect([bellButton, search, nav].map((node) => node.hasAttribute('inert'))).toEqual([false, false, false]);
    // Already inert before: left inert.
    expect(main.hasAttribute('inert')).toBe(true);
  });
});
