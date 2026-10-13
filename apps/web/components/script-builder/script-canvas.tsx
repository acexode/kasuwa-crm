'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import type { ScriptGraph } from '../../lib/script-graph';
import { layout, targetsOf } from './builder-model';

/**
 * The P10/05 canvas: every node of the graph at its served position, with
 * its kind and its title, and the edges between them. Positions are layout
 * only (they never change a run), and the canvas scrolls inside itself so the
 * page never scrolls sideways at 360 px.
 *
 * Titles are the author's wording, drawn as TEXT: markup in a title is
 * characters on the screen, never parsed. The edges take their colour from a
 * token through `currentColor`; nothing here names a colour.
 */

const NODE_WIDTH = 224;
const NODE_HEIGHT = 76;
const MARGIN = 40;

export function ScriptCanvas({
  t,
  graph,
  selected,
  invalid,
  onSelect,
}: {
  t: Translator;
  graph: ScriptGraph;
  selected: string | null;
  invalid: ReadonlySet<string>;
  onSelect: (id: string) => void;
}) {
  const placed = layout(graph);
  const width = Math.max(...[...placed.values()].map((point) => point.x), 0) + NODE_WIDTH + MARGIN;
  const height = Math.max(...[...placed.values()].map((point) => point.y), 0) + NODE_HEIGHT + MARGIN;
  const edges = graph.nodes.flatMap((node) => {
    const from = placed.get(node.id);
    if (from === undefined) return [];
    return targetsOf(node).flatMap((target, index) => {
      const to = placed.get(target);
      if (to === undefined || target === node.id) return [];
      return [{ key: `${node.id}-${index}-${target}`, x1: from.x + NODE_WIDTH / 2, y1: from.y + NODE_HEIGHT, x2: to.x + NODE_WIDTH / 2, y2: to.y }];
    });
  });

  return (
    <div
      data-testid="script-canvas"
      role="group"
      aria-label={t.t('scripting.builder.canvas')}
      className="h-96 w-full min-w-0 overflow-auto rounded-lg border border-border bg-surface-sunken"
    >
      <div className="relative" style={{ width, height }}>
        <svg aria-hidden="true" className="absolute inset-0 text-border-strong" width={width} height={height}>
          {edges.map((edge) => (
            <line key={edge.key} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke="currentColor" strokeWidth={2} />
          ))}
        </svg>
        {graph.nodes.map((node) => {
          const point = placed.get(node.id) ?? { x: 0, y: 0 };
          const active = node.id === selected;
          const broken = invalid.has(node.id);
          return (
            <button
              key={node.id}
              type="button"
              data-node={node.id}
              data-node-type={node.type}
              data-invalid={broken ? 'true' : undefined}
              aria-pressed={active}
              onClick={() => onSelect(node.id)}
              style={{ left: point.x, top: point.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
              className={`absolute flex flex-col items-start justify-center gap-1 overflow-hidden rounded-md border-2 bg-surface px-3 text-start shadow-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                broken ? 'border-danger' : active ? 'border-primary' : node.type === 'compliance' ? 'border-warning' : 'border-border'
              }`}
            >
              <span className="flex w-full items-center gap-2 text-caption font-bold uppercase text-text-2">
                {t.t(`scripting.nodeType.${node.type}` as MessageId)}
                {node.id === graph.startNodeId ? <span className="rounded-sm bg-primary-soft px-1 text-primary-text">{t.t('scripting.builder.start')}</span> : null}
                {broken ? <span className="rounded-sm bg-danger-soft px-1 text-danger-text">{t.t('scripting.builder.invalid')}</span> : null}
              </span>
              <span data-script-text="" className="w-full truncate text-body-sm font-semibold text-text">
                {node.title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
