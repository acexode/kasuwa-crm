'use client';

import { useMemo, useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import type { LanguageOption } from '../auth/language-menu';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import { OfflineBanner } from '../records/list-parts';
import { useOnline } from '../script-builder/use-online';
import type { InboxPlaceholders } from '../../lib/feature-flags';

/**
 * P08 — Inbox three-pane frame (T-0192, D-L194): queue list, thread and
 * contact pane at desktop; two-level navigation on a phone. No conversations
 * are invented — the empty queue is the default until the inbox API lands.
 */

type MobileView = 'list' | 'thread' | 'info';

function ToolButton({
  label,
  icon,
  disabled,
  soon,
}: {
  label: string;
  icon: 'mail' | 'auto_awesome' | 'payments' | 'sticky_note_2' | 'forum';
  disabled: boolean;
  soon?: string | undefined;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex min-h-control-sm min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md px-2 text-caption font-semibold text-text-2 disabled:cursor-not-allowed disabled:text-disabled-text"
    >
      <Icon name={icon} size={20} />
      <span className="truncate">{label}</span>
      {soon === undefined ? null : <span className="sr-only">{soon}</span>}
    </button>
  );
}

function EmptyQueue({ t }: { t: ReturnType<typeof createBundleTranslator> }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon name="forum" size={32} className="text-text-muted" />
      <p className="text-body-sm font-semibold">{t.t('inbox.queue.empty')}</p>
      <p className="max-w-sm text-meta text-text-2">{t.t('inbox.queue.emptyBody')}</p>
    </div>
  );
}

export function InboxScreen({
  locale,
  messages,
  locales,
  live,
  placeholders,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  placeholders: InboxPlaceholders;
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const [mobile, setMobile] = useState<MobileView>('list');
  const soon = t.t('records.nav.soon');

  const composerTools = useMemo(
    () => [
      { key: 'template', label: t.t('inbox.composer.template'), icon: 'mail' as const, on: placeholders.templates },
      { key: 'ai', label: t.t('inbox.composer.ai'), icon: 'auto_awesome' as const, on: placeholders.aiAssist },
      { key: 'payment', label: t.t('inbox.composer.payment'), icon: 'payments' as const, on: placeholders.payments },
      { key: 'note', label: t.t('inbox.composer.note'), icon: 'sticky_note_2' as const, on: placeholders.notes },
      { key: 'channel', label: t.t('inbox.composer.channel'), icon: 'forum' as const, on: placeholders.channels },
    ],
    [placeholders, t],
  );

  const queuePane = (
    <section
      data-testid="inbox-queue"
      className="flex min-h-0 min-w-0 flex-col border-border md:w-[280px] md:shrink-0 md:border-e"
    >
      <header className="flex min-h-[52px] items-center border-b border-border px-4">
        <h2 className="text-label">{t.t('inbox.queue.title')}</h2>
      </header>
      <EmptyQueue t={t} />
    </section>
  );

  const threadPane = (
    <section
      data-testid="inbox-thread"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-border md:border-e"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <Icon name="chat" size={32} className="text-text-muted" />
        <p className="text-body-sm font-semibold">{t.t('inbox.thread.empty')}</p>
        <p className="max-w-md text-meta text-text-2">{t.t('inbox.thread.emptyBody')}</p>
      </div>
      <div className="border-t border-border bg-surface-sunken p-3">
        <div className="mb-2 flex gap-1 overflow-x-auto">
          {composerTools.map((tool) => (
            <ToolButton
              key={tool.key}
              label={tool.label}
              icon={tool.icon}
              disabled={!online || !tool.on}
              {...(tool.on ? {} : { soon })}
            />
          ))}
        </div>
        <label className="sr-only" htmlFor="inbox-composer">
          {t.t('inbox.composer.placeholder')}
        </label>
        <textarea
          id="inbox-composer"
          readOnly
          disabled={!online}
          placeholder={t.t('inbox.composer.placeholder')}
          className="min-h-[88px] w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-body-sm disabled:cursor-not-allowed disabled:bg-surface-sunken"
        />
        <div className="mt-2 flex justify-end">
          <Button size="compact" disabled={!online}>
            {t.t('inbox.composer.send')}
          </Button>
        </div>
      </div>
    </section>
  );

  const infoPane = (
    <aside data-testid="inbox-contact" className="hidden min-h-0 w-[280px] shrink-0 flex-col md:flex">
      <header className="flex min-h-[52px] items-center border-b border-border px-4">
        <h2 className="text-label">{t.t('inbox.pane.contact')}</h2>
      </header>
      <p className="flex flex-1 items-start gap-2 px-4 py-6 text-meta text-text-2">
        <Icon name="person" size={18} className="text-text-muted" />
        {t.t('inbox.pane.empty')}
      </p>
    </aside>
  );

  return (
    <CrmShell locale={locale} t={t} locales={locales} live={live} current="inbox">
      <div data-testid="p08-inbox" data-locale={locale} className="flex min-h-0 flex-1 flex-col">
        {!online ? (
          <OfflineBanner t={t} locale={locale} syncedAt={null} />
        ) : null}
        <p className="border-b border-border px-4 py-2 text-meta text-text-2 md:px-6">{t.t('inbox.subtitle')}</p>
        <div className="hidden min-h-0 flex-1 md:flex">{queuePane}{threadPane}{infoPane}</div>
        <div className="flex min-h-0 flex-1 flex-col md:hidden">
          {mobile === 'list' ? (
            <>
              {queuePane}
              <button
                type="button"
                className="mx-4 mb-4 min-h-control-md rounded-md border border-border bg-surface-sunken text-meta font-semibold"
                onClick={() => setMobile('thread')}
              >
                {t.t('inbox.thread.empty')}
              </button>
            </>
          ) : null}
          {mobile === 'thread' ? (
            <>
              <button type="button" className="mx-4 mt-2 text-start text-meta font-semibold text-primary-text" onClick={() => setMobile('list')}>
                {t.t('shell.back')}
              </button>
              {threadPane}
            </>
          ) : null}
        </div>
      </div>
    </CrmShell>
  );
}
