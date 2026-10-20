'use client';

import type { Translator } from '@kasuwa/i18n/bundle';
import { Drawer } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { WIDGETS, widgetDescription, widgetTitle, type HomeRole, type WidgetType } from './home-model';

/**
 * Customise mode's "Add widget" (P03 frames 21 to 23): the T-0129 Drawer, which
 * is the right drawer from 640px up and the bottom sheet below it. "Suggested
 * for {role}" lists the role's own and suggested widgets not on Home yet, then
 * "All widgets" every other one this process can draw. Each row is a 36px
 * tile, the title over one line of description, and a 40px Add.
 */

function Row({
  t,
  type,
  suggested,
  onAdd,
}: {
  t: Translator;
  type: WidgetType;
  suggested: boolean;
  onAdd: (type: WidgetType) => void;
}) {
  const title = t.t(widgetTitle(type));
  return (
    <div className="flex items-center gap-3 rounded-10 border border-border px-3 py-2.5">
      <span
        aria-hidden="true"
        className={`flex size-9 shrink-0 items-center justify-center rounded-md ${
          suggested ? 'bg-primary-soft text-primary-text' : 'bg-surface-sunken text-text-2'
        }`}
      >
        <Icon name={WIDGETS[type].icon} size={20} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <b className="text-body-sm font-bold">{title}</b>
        <span className="text-caption font-normal text-text-2">{t.t(widgetDescription(type))}</span>
      </div>
      <button
        type="button"
        aria-label={t.t('home.add.addOne', { title })}
        onClick={() => onAdd(type)}
        className="h-10 shrink-0 rounded-md border border-border-strong bg-surface px-3 text-meta font-bold text-text outline-none is-hover:bg-surface-sunken focus-visible:ring-focus"
      >
        {t.t('home.add.button')}
      </button>
    </div>
  );
}

export function AddWidgetPanel({
  t,
  open,
  role,
  suggested,
  more,
  onAdd,
  onClose,
}: {
  t: Translator;
  open: boolean;
  role: HomeRole;
  suggested: readonly WidgetType[];
  more: readonly WidgetType[];
  onAdd: (type: WidgetType) => void;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t.t('home.add.title')}
      subtitle={t.t('home.add.subtitle')}
      closeLabel={t.t('home.add.close')}
    >
      <div className="flex flex-col gap-2">
        {suggested.length === 0 ? null : (
          <>
            <span className="py-1 text-overline text-text-muted">
              {t.t('home.add.suggested', { role: t.t(`home.role.${role}`) })}
            </span>
            {suggested.map((type) => (
              <Row key={type} t={t} type={type} suggested onAdd={onAdd} />
            ))}
          </>
        )}
        {more.length === 0 ? null : (
          <>
            <span className="pb-1 pt-2 text-overline text-text-muted">{t.t('home.add.all')}</span>
            {more.map((type) => (
              <Row key={type} t={t} type={type} suggested={false} onAdd={onAdd} />
            ))}
          </>
        )}
        {suggested.length === 0 && more.length === 0 ? (
          <p className="m-0 text-body-sm text-text-2">{t.t('home.add.none')}</p>
        ) : null}
      </div>
    </Drawer>
  );
}
