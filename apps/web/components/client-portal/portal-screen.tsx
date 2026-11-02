'use client';

import { useState } from 'react';
import { createBundleTranslator, type MessageBundle } from '@kasuwa/i18n/bundle';
import { SegmentedControl, Tabs, type SegmentedOption, type TabItem } from '@kasuwa/ui/components';
import type { LanguageOption } from '../auth/language-menu';
import { Icon } from '../icon';
import { Brand, SHELL_FOCUS } from '../shell/shell-parts';

/**
 * P23 — BPO client portal (T-0184, D-L194): programme selector, dashboard and
 * reports; SLA, recordings and QA in the design's empty state until their
 * backends land. Not the agent CRM shell — clients never see the rail.
 */

type View = 'dashboard' | 'reports' | 'sla' | 'recordings' | 'qa';

const PRIMARY_VIEWS: readonly View[] = ['dashboard', 'reports'];

function EmptyPanel({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: 'dashboard' | 'bar_chart' | 'schedule' | 'mic' | 'verified';
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <Icon name={icon} size={32} className="text-text-muted" />
      <p className="text-body font-semibold">{title}</p>
      <p className="max-w-md text-meta text-text-2">{body}</p>
    </div>
  );
}

export function ClientPortalScreen({
  locale,
  messages,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
}) {
  const t = createBundleTranslator(locale, messages);
  const [view, setView] = useState<View>('dashboard');
  const soon = t.t('records.nav.soon');

  const navItems: readonly TabItem[] = [
    { value: 'dashboard', label: t.t('clientPortal.nav.dashboard') },
    { value: 'reports', label: t.t('clientPortal.nav.reports') },
    { value: 'sla', label: t.t('clientPortal.nav.sla') },
    { value: 'recordings', label: t.t('clientPortal.nav.recordings') },
    { value: 'qa', label: t.t('clientPortal.nav.qa') },
  ];

  const mobileOptions: readonly SegmentedOption[] = navItems.map((item) => ({
    value: item.value as View,
    label: item.label,
  }));

  const body = (() => {
    if (view === 'dashboard') {
      return (
        <EmptyPanel
          icon="dashboard"
          title={t.t('clientPortal.dashboard.empty.title')}
          body={t.t('clientPortal.dashboard.empty.body')}
        />
      );
    }
    if (view === 'reports') {
      return (
        <EmptyPanel
          icon="bar_chart"
          title={t.t('clientPortal.reports.empty.title')}
          body={t.t('clientPortal.reports.empty.body')}
        />
      );
    }
    if (view === 'sla') {
      return <EmptyPanel icon="schedule" title={t.t('clientPortal.nav.sla')} body={t.t('clientPortal.sla.empty')} />;
    }
    if (view === 'recordings') {
      return (
        <EmptyPanel icon="mic" title={t.t('clientPortal.nav.recordings')} body={t.t('clientPortal.recordings.empty')} />
      );
    }
    return <EmptyPanel icon="verified" title={t.t('clientPortal.nav.qa')} body={t.t('clientPortal.qa.empty')} />;
  })();

  return (
    <div data-testid="p23-portal" data-locale={locale} className="flex min-h-screen flex-col bg-bg">
      <header className="flex min-h-shell-header items-center gap-3 border-b border-border bg-surface px-4 md:px-6">
        <Brand t={t} href={null} />
        <span className="hidden text-meta text-text-2 md:inline">{t.t('clientPortal.title')}</span>
        <span className="flex-1" />
        <button type="button" disabled className={`min-h-control-sm rounded-md px-3 text-meta font-semibold text-disabled-text ${SHELL_FOCUS}`}>
          {t.t('auth.signOut')}
        </button>
      </header>
      <div className="mx-auto flex w-full max-w-content flex-1 flex-col gap-4 px-4 py-4 md:gap-5 md:px-6 md:py-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <label className="flex min-h-control-md flex-col gap-1 text-meta font-semibold text-text-2">
            {t.t('clientPortal.programme.label')}
            <select
              disabled
              className="min-h-control-md rounded-md border border-border bg-surface-sunken px-3 text-body-sm text-disabled-text"
              aria-describedby="portal-programme-hint"
            >
              <option>{t.t('clientPortal.programme.empty')}</option>
            </select>
          </label>
          <p id="portal-programme-hint" className="text-caption text-text-2">
            {soon}
          </p>
        </div>
        <div className="hidden md:block">
          <Tabs
            items={navItems}
            value={view}
            onValueChange={(next) => setView(next as View)}
            aria-label={t.t('clientPortal.title')}
          />
        </div>
        <div className="md:hidden">
          <SegmentedControl
            options={mobileOptions.slice(0, 3)}
            value={view}
            onValueChange={(value) => setView(value as View)}
            aria-label={t.t('clientPortal.title')}
          />
        </div>
        <section
          data-testid={`portal-${view}`}
          className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface"
        >
          {PRIMARY_VIEWS.includes(view) ? body : (
            <>
              <p className="border-b border-border px-4 py-2 text-caption text-text-2">{soon}</p>
              {body}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
