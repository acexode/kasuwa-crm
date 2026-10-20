'use client';

import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { TypePill } from '../script-shared/node-style';
import type { ScriptGraph, ScriptNode } from '../../lib/script-graph';
import { layout } from './builder-model';

/**
 * The P10/05 canvas (T-0139, the export's "Canvas"): every node of the graph
 * at its served position, as a 250×100 card with its type pill, its title and
 * a three-line preview of its wording, and the routes between them as curves
 * ending in a dot, labelled where a route is an answer or a branch side.
 * Positions are layout only (they never change a run). The dot grid and the
 * scrolling belong to the column around this; the page never scrolls
 * sideways.
 *
 * Titles and wording are the author's, drawn as TEXT: markup in them is
 * characters on the screen, never parsed. `{variable}` tokens are drawn as
 * code chips. The edges take their colour from a token through
 * `currentColor`; nothing here names a colour.
 */

export const NODE_WIDTH = 250;
export const NODE_HEIGHT = 100;
const MARGIN = 40;

/** What a node's card previews, in the language being edited. */
export interface NodePreview {
  /** The wording to show, or null when there is none in any language. */
  readonly text: string | null;
  /** The note when the edited language has no wording and the source is shown instead. */
  readonly missing: string | null;
}

interface Edge {
  readonly key: string;
  readonly d: string;
  readonly x2: number;
  readonly y2: number;
  readonly lx: number;
  readonly ly: number;
  readonly label: string | null;
}

/** A route's curve, as the export draws it: side to side on one row, otherwise bottom to top. */
function curve(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Omit<Edge, 'key' | 'label'> {
  if (Math.abs(from.y - to.y) < 20) {
    const forward = to.x >= from.x;
    const x1 = forward ? from.x + NODE_WIDTH : from.x;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = forward ? to.x : to.x + NODE_WIDTH;
    const y2 = to.y + NODE_HEIGHT / 2;
    const bend = forward ? 20 : -20;
    return {
      d: `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      x2,
      y2,
      lx: (x1 + x2) / 2,
      ly: (y1 + y2) / 2,
    };
  }
  const x1 = from.x + NODE_WIDTH / 2;
  const y1 = from.y + NODE_HEIGHT;
  const x2 = to.x + NODE_WIDTH / 2;
  const y2 = to.y;
  const middle = (y2 - y1) / 2;
  return {
    d: `M${x1} ${y1} C${x1} ${y1 + middle}, ${x2} ${y2 - middle}, ${x2} ${y2}`,
    x2,
    y2,
    lx: (x1 + x2) / 2,
    ly: (y1 + y2) / 2,
  };
}

/** Each route out of a node, with the label the export puts on it. */
function routes(t: Translator, node: ScriptNode): { target: string; label: string | null }[] {
  switch (node.type) {
    case 'say':
    case 'form':
    case 'compliance':
      return [{ target: node.next, label: null }];
    case 'question':
      return node.choices.map((choice) => ({ target: choice.next, label: choice.label }));
    case 'branch':
      return [
        { target: node.whenTrue, label: t.t('scripting.builder.bool.true') },
        { target: node.whenFalse, label: t.t('scripting.builder.bool.false') },
      ];
    case 'end':
      return [];
  }
}

/** Wording with its `{variable}` tokens split out, so they can be drawn as code. */
export function tokens(text: string): { text: string; variable: boolean }[] {
  return text
    .split(/(\{[A-Za-z0-9_.]+\})/)
    .filter((part) => part !== '')
    .map((part) =>
      /^\{[A-Za-z0-9_.]+\}$/.test(part)
        ? { text: part.slice(1, -1), variable: true }
        : { text: part, variable: false },
    );
}

export function Variable({ text }: { text: string }) {
  return (
    <code className="rounded-[3px] bg-primary-soft px-0.75 font-mono text-micro font-normal text-primary-text">
      {text}
    </code>
  );
}

function BranchPreview({
  t,
  node,
}: {
  t: Translator;
  node: Extract<ScriptNode, { type: 'branch' }>;
}) {
  const condition = node.condition;
  const subject =
    condition.source === 'contact_field'
      ? `contact.${condition.field}`
      : t.t('scripting.builder.source.answer');
  const value =
    condition.value === undefined || condition.value === null ? null : String(condition.value);
  return (
    <>
      {t.t('scripting.builder.branch.if')}{' '}
      {condition.source === 'contact_field' ? <Variable text={subject} /> : subject}{' '}
      {t.t(`scripting.builder.operator.${condition.operator}` as MessageId)}
      {value === null ? null : <span data-script-text=""> {value}</span>}
    </>
  );
}

export function ScriptCanvas({
  t,
  graph,
  selected,
  invalid,
  preview,
  onSelect,
}: {
  t: Translator;
  graph: ScriptGraph;
  selected: string | null;
  invalid: ReadonlySet<string>;
  preview: (node: ScriptNode) => NodePreview;
  onSelect: (id: string) => void;
}) {
  const placed = layout(graph);
  const points = [...placed.values()];
  const width = Math.max(...points.map((point) => point.x), 0) + NODE_WIDTH + MARGIN;
  const height = Math.max(...points.map((point) => point.y), 0) + NODE_HEIGHT + MARGIN;
  const edges: Edge[] = graph.nodes.flatMap((node) => {
    const from = placed.get(node.id);
    if (from === undefined) return [];
    return routes(t, node).flatMap((route, index) => {
      const to = placed.get(route.target);
      if (to === undefined || route.target === node.id) return [];
      return [
        { key: `${node.id}-${index}-${route.target}`, label: route.label, ...curve(from, to) },
      ];
    });
  });

  return (
    <div
      data-testid="script-canvas"
      role="group"
      aria-label={t.t('scripting.builder.canvas')}
      className="relative mx-auto shrink-0"
      style={{ width, height }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 text-border-strong"
        width={width}
        height={height}
      >
        {edges.map((edge) => (
          <g key={edge.key}>
            <path d={edge.d} fill="none" stroke="currentColor" strokeWidth={1.5} />
            <circle cx={edge.x2} cy={edge.y2} r={3.5} fill="currentColor" />
          </g>
        ))}
      </svg>
      {edges.map((edge) =>
        edge.label === null ? null : (
          <span
            key={`label-${edge.key}`}
            aria-hidden="true"
            data-script-text=""
            style={{ left: edge.lx, top: edge.ly }}
            className="pointer-events-none absolute max-w-[132px] -translate-x-1/2 -translate-y-1/2 truncate whitespace-nowrap rounded-full border border-border-strong bg-surface px-2 py-0.5 text-micro text-text-2"
          >
            {edge.label}
          </span>
        ),
      )}
      {graph.nodes.map((node) => {
        const point = placed.get(node.id) ?? { x: 0, y: 0 };
        const active = node.id === selected;
        const broken = invalid.has(node.id);
        const shown = node.type === 'branch' ? null : preview(node);
        const missing = shown?.missing ?? null;
        const empty =
          node.type !== 'branch' && (shown === null || shown.text === null || shown.text === '');
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
            className={`absolute flex flex-col items-stretch gap-1.5 overflow-hidden rounded-10 bg-surface px-3 py-2.5 text-start text-text is-focus-visible:ring-focus ${
              broken
                ? 'border-2 border-danger shadow-1'
                : active
                  ? 'border-2 border-primary shadow-2'
                  : missing !== null
                    ? 'border border-dashed border-warning shadow-1'
                    : 'border border-border shadow-1'
            }`}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <TypePill t={t} type={node.type} size="canvas" />
              <b data-script-text="" className="min-w-0 flex-1 truncate text-meta font-bold">
                {node.title}
              </b>
              {broken ? (
                <span
                  title={t.t('scripting.builder.invalid')}
                  className="flex shrink-0 text-danger-text"
                >
                  <Icon name="error" size={16} />
                  <span className="sr-only">{t.t('scripting.builder.invalid')}</span>
                </span>
              ) : missing !== null ? (
                <span title={missing} className="flex shrink-0 text-warning-text">
                  <Icon name="warning" size={16} />
                  <span className="sr-only">{missing}</span>
                </span>
              ) : null}
            </span>
            <span
              className={`line-clamp-3 text-caption font-normal leading-[17px] ${empty || missing !== null ? 'text-text-muted' : 'text-text-2'}`}
            >
              {node.type === 'branch' ? (
                <BranchPreview t={t} node={node} />
              ) : empty || shown === null || shown.text === null ? (
                t.t('scripting.builder.emptyLine')
              ) : (
                tokens(shown.text).map((part, index) =>
                  part.variable ? (
                    <Variable key={index} text={part.text} />
                  ) : (
                    <span key={index} data-script-text="">
                      {part.text}
                    </span>
                  ),
                )
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
