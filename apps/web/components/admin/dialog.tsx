'use client';

import type { ReactNode } from 'react';
import type { IconName } from '@kasuwa/ui';
import { Dialog as UiDialog, type DialogSize } from '@kasuwa/ui/components';
import { Icon } from '../icon';

/**
 * The console's modal dialogs (`P02/B5`, `B9`, `C3`, `D2`, `E2`), on the
 * T-0129 Dialog (T-0140).
 *
 * The T-0129 Dialog owns the three accessibility obligations that get
 * forgotten: focus moves in on open, it is trapped while open, and it returns
 * to the control that opened it on close. Esc, the close button and a scrim
 * press dismiss; the page behind is inert and does not scroll; on a phone the
 * dialog is full screen.
 *
 * What this wrapper adds is the P02 export's shape: a 40px tone tile beside an
 * 18/700 title, one sentence of body in text-2, and a footer of 40px actions
 * at the end. Every P02 dialog carries two or three actions and each matters
 * on a phone too ("Deactivate instead"), so the footer keeps them all at
 * every width rather than dropping the secondary ones.
 */

export type DialogTone = 'danger' | 'warning' | 'info';

const TONE_CLASS: Readonly<Record<DialogTone, string>> = {
  danger: 'bg-danger-soft text-danger-text',
  warning: 'bg-warning-soft text-warning-text',
  info: 'bg-info-soft text-info-text',
};

export function Dialog({
  title,
  body,
  icon,
  tone,
  closeLabel,
  onClose,
  children,
  footer,
  testId,
  size = 'form',
}: {
  title: string;
  body?: string;
  icon: IconName;
  tone: DialogTone;
  closeLabel: string;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
  testId?: string;
  size?: DialogSize;
}) {
  return (
    <UiDialog
      open
      onClose={onClose}
      closeLabel={closeLabel}
      size={size}
      testId={testId}
      title={
        <span className="flex items-center gap-3.5">
          <span
            aria-hidden="true"
            className={`flex size-10 shrink-0 items-center justify-center rounded-10 ${TONE_CLASS[tone]}`}
          >
            <Icon name={icon} size={22} />
          </span>
          <span className="min-w-0 text-pretty">{title}</span>
        </span>
      }
      description={body}
      // An empty note selects the footer that keeps every action on a phone;
      // the actions themselves sit at the end, as the export draws them.
      footerNote=""
      secondaryAction={<span className="flex flex-wrap justify-end gap-2">{footer}</span>}
    >
      {children}
    </UiDialog>
  );
}
