/**
 * Makes everything on the page except `keep` inert, and hands back the undo
 * (T-0101, N13). The bell's dropdown is a modal dialog (`aria-modal`), so the
 * page behind it must neither take focus nor be read, exactly as the command
 * palette does with `inert` on the shell's regions. The dropdown sits INSIDE
 * the header, so the header cannot itself be inert: instead every sibling of
 * `keep`, and of each of its ancestors up to `<body>`, is.
 *
 * Only what this call made inert is restored, so a region that was already
 * inert (the palette's) stays so. Scripts, styles and the framework's route
 * announcer are left alone.
 *
 * No DOM types are named, so it is a unit test on plain objects.
 */
export interface InertNode {
  readonly tagName: string;
  readonly parentElement: InertNode | null;
  readonly children: ArrayLike<InertNode>;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const LEFT_ALONE = new Set(['SCRIPT', 'STYLE', 'LINK', 'NEXT-ROUTE-ANNOUNCER']);

export function inertOutside(keep: InertNode): () => void {
  const made: InertNode[] = [];
  let node: InertNode = keep;
  while (node.parentElement !== null && node.tagName !== 'BODY') {
    const parent: InertNode = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || LEFT_ALONE.has(sibling.tagName) || sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      made.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const sibling of made) sibling.removeAttribute('inert');
  };
}
