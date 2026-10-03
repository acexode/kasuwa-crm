'use client';

import { useEffect, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { PRIMARY_BUTTON, QUIET_BUTTON } from '../auth/button-classes';
import type { LanguageOption } from '../auth/language-menu';
import type { InviteAddress } from '../../lib/invite-emails';
import { ONBOARDING_CURRENCIES, type OnboardingCurrency } from '../../lib/money-format';
import { ImportStep, columnsToFix, type CsvMapping, type ImportSource } from './import-step';
import { InviteStep, type InviteRole } from './invite-step';
import { OnboardingShell } from './onboarding-shell';
import { CurrencyStep, WhatsAppStep } from './simple-steps';

/**
 * `P01/5.2`–`5.5` and `P01/6` — the first-admin-login flow (D-P2, T-0018).
 *
 * NOT behind `self_serve_signup`. A tenant provisioned by hand (T-0015) still
 * has to choose a currency, connect a number, bring its contacts and invite
 * its agents; gating these behind the self-serve switch would strand every
 * launch tenant halfway through setup.
 *
 * ---------------------------------------------------------------------------
 * STEP STATE IS CLIENT-SIDE, AND THAT IS A KNOWN GAP, NOT THE DESIGN.
 *
 * The board says the checklist stays on Home until it is finished, which means
 * wizard state belongs on the server — an admin who closes the tab mid-import
 * should come back to where they were, on any device. There is no endpoint or
 * table for it yet; inventing one is a decision (CLAUDE.md section 8) and it
 * is T-0018's. Until then a reload starts the wizard again, and the report for
 * this task says so in as many words.
 * ---------------------------------------------------------------------------
 */

const STAGES = ['currency', 'whatsapp', 'import', 'team', 'done'] as const;
type Stage = (typeof STAGES)[number];

const SCREEN: Record<Stage, string> = {
  currency: 'P01/5.2',
  whatsapp: 'P01/5.3',
  import: 'P01/5.4',
  team: 'P01/5.5',
  done: 'P01/6',
};

/** Position in the five-step stepper. Step 1 (data region) is `P01/5.1`. */
const STEP_NUMBER: Record<Stage, number | null> = {
  currency: 2,
  whatsapp: 3,
  import: 4,
  team: 5,
  done: null,
};

const DEFAULT_CUSTOMER_LANGUAGES = ['en', 'pcm', 'yo'];

export function OnboardingWizard({
  messages,
  locale,
  locales,
  customerLanguages,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
  customerLanguages: readonly LanguageOption[];
}) {
  const t = createBundleTranslator(locale, messages);
  const sectionRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  const [stage, setStage] = useState<Stage>('currency');
  const [currency, setCurrency] = useState<OnboardingCurrency>(
    ONBOARDING_CURRENCIES[0] ?? { code: 'NGN', formatLocale: 'en-NG' },
  );
  const [teamLanguage, setTeamLanguage] = useState(locale);
  const [chosenLanguages, setChosenLanguages] = useState<ReadonlySet<string>>(
    () => new Set(DEFAULT_CUSTOMER_LANGUAGES.filter((code) => customerLanguages.some((option) => option.code === code))),
  );
  const [source, setSource] = useState<ImportSource>('csv');
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [invites, setInvites] = useState<readonly InviteAddress[]>([]);
  const [role, setRole] = useState<InviteRole>('agent');

  // A new step is a new page to a screen-reader user: move focus to its heading
  // rather than leaving it on a button that no longer means what it did.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    sectionRef.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [stage]);

  const index = STAGES.indexOf(stage);
  const go = (next: Stage | undefined) => {
    if (next !== undefined) setStage(next);
  };
  const step = STEP_NUMBER[stage];
  const skippable = stage === 'whatsapp' || stage === 'import' || stage === 'team';

  return (
    <OnboardingShell
      t={t}
      locales={locales}
      locale={locale}
      step={step}
      back={
        index > 0 && stage !== 'done'
          ? { label: t.t('onboarding.back'), onClick: () => go(STAGES[index - 1]) }
          : undefined
      }
      skip={
        skippable
          ? { label: t.t('onboarding.skip'), onClick: () => go(STAGES[index + 1]), testId: 'onboarding-skip' }
          : undefined
      }
      next={
        stage === 'done'
          ? undefined
          : {
              label: t.t(stage === 'team' ? 'onboarding.finish' : 'onboarding.continue'),
              onClick: () => go(STAGES[index + 1]),
              testId: 'onboarding-continue',
            }
      }
    >
      <section ref={sectionRef} data-screen={SCREEN[stage]} className="flex w-full max-w-2xl flex-col gap-5">
        {stage === 'currency' ? (
          <CurrencyStep
            t={t}
            currency={currency}
            onCurrency={setCurrency}
            teamLanguages={locales}
            teamLanguage={teamLanguage}
            onTeamLanguage={setTeamLanguage}
            customerLanguages={customerLanguages}
            chosenCustomerLanguages={chosenLanguages}
            onToggleCustomerLanguage={(code) =>
              setChosenLanguages((previous) => {
                const next = new Set(previous);
                if (next.has(code)) next.delete(code);
                else next.add(code);
                return next;
              })
            }
          />
        ) : null}
        {stage === 'whatsapp' ? <WhatsAppStep t={t} /> : null}
        {stage === 'import' ? (
          <ImportStep t={t} source={source} onSource={setSource} mapping={mapping} onMapping={setMapping} />
        ) : null}
        {stage === 'team' ? (
          <InviteStep t={t} invites={invites} onInvites={setInvites} role={role} onRole={setRole} />
        ) : null}
        {stage === 'done' ? (
          <Checklist
            t={t}
            mapping={mapping}
            inviteCount={invites.filter((entry) => entry.problem === null).length}
            onGo={(next) => setStage(next)}
          />
        ) : null}
      </section>
    </OnboardingShell>
  );
}

type ItemState = 'done' | 'progress' | 'todo';

interface ChecklistItem {
  readonly key: string;
  readonly state: ItemState;
  readonly title: string;
  readonly detail: string;
  readonly action?: { readonly label: string; readonly stage: Stage };
}

/**
 * `P01/6` — done, in progress and to-do. Every line is derived from what the
 * admin actually did in this session; nothing claims more than happened. An
 * invite that was typed but not sent says "on the list", not "sent", and
 * WhatsApp stays to-do because nothing here can connect it yet.
 */
function Checklist({
  t,
  mapping,
  inviteCount,
  onGo,
}: {
  t: Translator;
  mapping: CsvMapping | null;
  inviteCount: number;
  onGo: (stage: Stage) => void;
}) {
  const items: ChecklistItem[] = [
    { key: 'workspace', state: 'done', title: t.t('done.item.workspace'), detail: t.t('done.item.workspace.detail') },
    { key: 'region', state: 'done', title: t.t('done.item.region'), detail: t.t('done.item.region.detail') },
    {
      key: 'whatsapp',
      state: 'todo',
      title: t.t('done.item.whatsapp'),
      detail: t.t('done.item.whatsapp.detail'),
      action: { label: t.t('done.action.connect'), stage: 'whatsapp' },
    },
    mapping === null
      ? {
          key: 'import',
          state: 'todo',
          title: t.t('done.item.import.todo'),
          detail: t.t('done.item.import.todo.detail'),
          action: { label: t.t('done.action.import'), stage: 'import' },
        }
      : {
          key: 'import',
          state: 'progress',
          title: t.t('done.item.import.progress'),
          detail: t.t('import.csv.summary', { rows: mapping.rows, fix: columnsToFix(mapping) }),
          action: { label: t.t('done.action.review'), stage: 'import' },
        },
    {
      key: 'team',
      state: inviteCount > 0 ? 'progress' : 'todo',
      title: t.t('done.item.team'),
      detail: inviteCount > 0 ? t.t('invite.count', { count: inviteCount }) : t.t('done.item.team.none'),
      action: { label: t.t('done.action.invite'), stage: 'team' },
    },
    { key: 'call', state: 'todo', title: t.t('done.item.call'), detail: t.t('done.item.call.detail') },
  ];

  return (
    <>
      <span className="flex h-16 w-16 items-center justify-center self-center rounded-full bg-success-soft text-success-text">
        <Icon name="check" size="xl" />
      </span>
      <div className="flex flex-col gap-2 text-center">
        <h1 tabIndex={-1} className="text-h3 text-text">
          {t.t('done.title')}
        </h1>
        <p className="text-body-md text-text-2">{t.t('done.subtitle')}</p>
      </div>

      <ul data-testid="checklist" className="flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li
            key={item.key}
            data-item={item.key}
            data-state={item.state}
            className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3"
          >
            <span
              aria-hidden="true"
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                item.state === 'done'
                  ? 'bg-success-soft text-success-text'
                  : item.state === 'progress'
                    ? 'bg-info-soft text-info-text'
                    : 'border-2 border-border-strong'
              }`}
            >
              {item.state === 'done' ? <Icon name="check" size="sm" /> : null}
              {item.state === 'progress' ? <Icon name="hourglass_top" size="sm" /> : null}
            </span>
            <span className="flex flex-1 flex-col">
              <span className="sr-only">{t.t(`done.state.${item.state}` as MessageId)}</span>
              <strong className={`text-body-sm ${item.state === 'done' ? 'font-medium text-text-2' : 'text-text'}`}>
                {item.title}
              </strong>
              <span className="text-body-sm text-text-2">{item.detail}</span>
            </span>
            {item.action !== undefined ? (
              <button type="button" onClick={() => onGo(item.action?.stage ?? 'done')} className={QUIET_BUTTON}>
                {item.action.label}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <a href="/admin" className={PRIMARY_BUTTON}>
        {t.t('done.home')}
      </a>
    </>
  );
}
