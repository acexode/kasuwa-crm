import type { IconName } from '@kasuwa/ui';
import type { MessageId, Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import type { NodeType } from '../../lib/script-graph';

/**
 * P10's node types as the design draws them (`TYPES` in the export): one tint
 * and one glyph per type, shared by the builder's palette, canvas and
 * inspector and by the agent's step cards (T-0139). Every value is a semantic
 * token utility; nothing here names a colour.
 *
 *   say         primary-soft / primary-text   record_voice_over
 *   question    info-soft / info-text         help
 *   branch      accent-soft / accent-text     alt_route
 *   form        success-soft / success-text   edit_note
 *   compliance  warning-soft / warning-text   gavel
 *   end         surface-sunken / text-2       flag
 */
export const NODE_STYLE: Readonly<
  Record<NodeType, { readonly icon: IconName; readonly tint: string }>
> = {
  say: { icon: 'record_voice_over', tint: 'bg-primary-soft text-primary-text' },
  question: { icon: 'help', tint: 'bg-info-soft text-info-text' },
  branch: { icon: 'alt_route', tint: 'bg-accent-soft text-accent-text' },
  form: { icon: 'edit_note', tint: 'bg-success-soft text-success-text' },
  compliance: { icon: 'gavel', tint: 'bg-warning-soft text-warning-text' },
  end: { icon: 'flag', tint: 'bg-surface-sunken text-text-2' },
};

/** The design's palette order: Say, Question, Branch, Form, Compliance, End. */
export const PALETTE_ORDER: readonly NodeType[] = [
  'say',
  'question',
  'branch',
  'form',
  'compliance',
  'end',
];

/**
 * A type pill. `canvas` is the node card's (20px, radius 5, 10/700 caps,
 * 13px glyph drawn at the 14px step); `card` is the inspector's and the
 * agent's step cards' (24px, radius 6, 11/700 caps, 14px glyph).
 */
export function TypePill({
  t,
  type,
  size = 'card',
}: {
  t: Translator;
  type: NodeType;
  size?: 'canvas' | 'card';
}) {
  const style = NODE_STYLE[type];
  return (
    <span
      data-type-pill={type}
      className={`inline-flex shrink-0 items-center whitespace-nowrap uppercase tracking-[.04em] ${style.tint} ${
        size === 'canvas'
          ? 'h-5 gap-0.75 rounded-[5px] px-1.5 text-rail-label font-bold'
          : 'h-6 gap-1 rounded-6 px-2 text-micro'
      }`}
    >
      <Icon name={style.icon} size={14} />
      {t.t(`scripting.nodeType.${type}` as MessageId)}
    </span>
  );
}
