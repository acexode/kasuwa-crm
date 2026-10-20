import { Fragment, type ReactNode } from 'react';

/**
 * Bold fragments inside translated sentences, as the P01 export draws them
 * ("There were … for **a•••@ojafoods.ng**", "**That email and password don't
 * match.** Check for typos…"), without splitting a sentence into
 * per-language fragments.
 *
 * `Emphasis` formats the sentence with a sentinel in place of the value, splits
 * on it and puts the node back, so every language keeps its own word order
 * around the value (the same trick as the onboarding money preview).
 */
/** Private-use characters: never in a catalogue, never typed by a user. */
const SENTINELS = ['\uE000', '\uE001', '\uE002'] as const;

export function Emphasis({
  sentence,
  values,
}: {
  /** Formats the message with the given placeholder texts, one per value. */
  sentence: (...placeholders: string[]) => string;
  values: readonly ReactNode[];
}) {
  const marks = SENTINELS.slice(0, values.length);
  const text = sentence(...marks);
  const pattern = new RegExp(`(${marks.join('|')})`);
  return (
    <>
      {text.split(pattern).map((part, index) => {
        const at = (marks as readonly string[]).indexOf(part);
        // Positions in one sentence, never reordered.
        return <Fragment key={index}>{at === -1 ? part : values[at]}</Fragment>;
      })}
    </>
  );
}

/**
 * The first sentence in bold, the rest plain: the export's alert pattern. The
 * split is the locale's own sentence boundary (`Intl.Segmenter`), not a full
 * stop, so it holds for every catalogue. Where the browser has no Segmenter
 * the message is shown whole and plain, which is the safe direction.
 */
export function LeadSentence({ text, locale }: { text: string; locale: string }) {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter === undefined) return <>{text}</>;
  const first = new Segmenter(locale, { granularity: 'sentence' }).segment(text)[Symbol.iterator]().next();
  if (first.done === true) return <>{text}</>;
  const lead = first.value.segment;
  const rest = text.slice(lead.length);
  if (rest.trim() === '') return <>{text}</>;
  return (
    <>
      <strong>{lead.trimEnd()}</strong> {rest.trimStart()}
    </>
  );
}
