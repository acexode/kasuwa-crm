'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type Translator } from '@kasuwa/i18n/bundle';
import { Button, EmptyState } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { QUIET_BUTTON, SECONDARY_BUTTON } from '../auth/button-classes';
import { FOCUS } from '../records/list-classes';
import { appendPage } from '../records/list-model';
import { useOnline } from '../script-builder/use-online';
import { listMyProgrammes } from '../../lib/my-programmes-api';
import { listPipelines, type PipelineError, type PipelineSummary } from '../../lib/pipelines-api';
import type { DealModules } from '../../lib/feature-flags';
import { errorMessage, pipelineHref } from './pipeline-model';
import { PipelineSelect, choiceLabel, pipelineChoices } from './pipeline-select';
import { DealsBarActions } from './bar-actions';
import { TEMPLATES, templateKey, type TemplateId } from './pipeline-templates';

/**
 * `/pipelines` (T-0109, R1; drawn to P06 in T-0135): the caller's pipelines,
 * each a link to its board, and the nav's Deals target. The design has no
 * index of its own: it folds the choice into the header's dropdown, so this
 * page is that header ("Deals" and the dropdown) over the list.
 *
 * Two pipelines of one name are told apart by their programme's name
 * ("B2B sales · Sahel Lagos"), read from the caller's own programmes.
 * listPipelines decides what the caller reaches; no id is printed.
 *
 * NO PIPELINE YET is P06/17: the first-pipeline template picker, behind
 * `pipeline_templates` (D-L194). No operation creates a pipeline, so its
 * Create is drawn disabled; without the flag it is the plain empty state.
 */
export function PipelineIndexScreen({
  locale,
  messages,
  locales,
  live,
  modules,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
  /** The D-L194 placeholders this process draws (read by the server page). */
  modules: Pick<DealModules, 'templates'>;
}) {
  const t = createBundleTranslator(locale, messages);
  const online = useOnline();
  const [rows, setRows] = useState<readonly PipelineSummary[]>([]);
  const [programmes, setProgrammes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [error, setError] = useState<PipelineError | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setPhase('loading');
    void Promise.all([listPipelines(), listMyProgrammes()]).then(([result, own]) => {
      if (mine !== sequence.current) return;
      // Without the programmes' names a shared name is still drawn, just unqualified.
      if (own.ok)
        setProgrammes(
          new Map(own.value.map((programme) => [programme.id, programme.name] as const)),
        );
      if (result.ok) {
        setRows(result.value.data);
        setCursor(result.value.nextCursor);
        setPhase('loaded');
        return;
      }
      setError(result.error);
      setPhase('error');
    });
  }, [retry]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    void listPipelines(cursor).then((result) => {
      setLoadingMore(false);
      if (result.ok) {
        setRows((current) => appendPage(current, result.value.data));
        setCursor(result.value.nextCursor);
      }
    });
  }, [cursor, loadingMore]);

  const choices = pipelineChoices(rows, programmes);
  const empty = phase === 'loaded' && rows.length === 0;

  return (
    <CrmShell
      t={t}
      locale={locale}
      locales={locales}
      current="deals"
      live={live}
      appBar={{ title: t.t('records.nav.deals'), actions: <DealsBarActions t={t} live={live} /> }}
    >
      <div data-screen="P06/index" className="flex min-w-0 flex-col gap-3 md:gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2.5">
          <h1 className="sr-only text-title md:not-sr-only">{t.t('records.nav.deals')}</h1>
          <PipelineSelect
            t={t}
            state={
              phase === 'loaded'
                ? { phase: 'ready', choices, more: cursor !== null }
                : { phase: 'loading' }
            }
            currentId={null}
            placeholder={
              empty && modules.templates
                ? t.t('pipeline.select.new')
                : t.t('pipeline.select.choose')
            }
            className="flex-1 basis-0 md:max-w-[280px] md:flex-initial md:basis-[280px]"
          />
        </div>
        {phase === 'loading' ? (
          <div aria-busy="true" className="flex max-w-[960px] flex-col gap-2">
            <span role="status" className="sr-only">
              {t.t('pipeline.index.loading')}
            </span>
            {[0, 1, 2].map((index) => (
              <span key={index} aria-hidden="true" className="h-14 rounded-lg bg-surface-sunken" />
            ))}
          </div>
        ) : phase === 'error' ? (
          <div
            role="alert"
            data-testid="pipeline-index-error"
            className="flex max-w-[960px] flex-col items-start gap-2 rounded-10 border-2 border-danger bg-danger-soft px-3.5 py-3 text-body-sm text-danger-text"
          >
            <p className="flex items-center gap-2 font-bold">
              <Icon name="error" size={20} />
              {t.t('pipeline.index.error')}
            </p>
            <p>{t.t(errorMessage(error ?? { status: 0, code: 'network', details: [] }, 'read'))}</p>
            <button
              type="button"
              data-requires-connection=""
              disabled={!online}
              onClick={() => setRetry((current) => current + 1)}
              className={QUIET_BUTTON}
            >
              {t.t('records.retry')}
            </button>
          </div>
        ) : rows.length === 0 ? (
          modules.templates ? (
            <TemplatePicker t={t} />
          ) : (
            <div
              data-testid="pipeline-index-empty"
              className="max-w-[960px] rounded-xl border border-border bg-surface p-7"
            >
              <EmptyState
                icon="view_kanban"
                title={t.t('pipeline.index.empty.title')}
                body={t.t('pipeline.index.empty.body')}
              />
            </div>
          )
        ) : (
          <section className="flex max-w-[960px] flex-col gap-3 rounded-xl border border-border bg-surface p-4 md:p-5">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-card-title">{t.t('pipeline.index.title')}</h2>
              <p className="text-meta text-text-2">{t.t('pipeline.index.intro')}</p>
            </div>
            <ul
              data-testid="pipeline-index"
              aria-label={t.t('pipeline.index.label')}
              className="flex flex-col"
            >
              {choices.map((choice) => {
                const href = pipelineHref(choice.id);
                const inner = (
                  <>
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text">
                      <Icon name="view_kanban" size={20} />
                    </span>
                    <span
                      data-record-text=""
                      className="min-w-0 flex-1 break-words text-label font-semibold"
                    >
                      {choiceLabel(t, choice)}
                    </span>
                  </>
                );
                const rowClass = 'flex min-h-14 items-center gap-3 px-1 py-2 text-text';
                return (
                  <li
                    key={choice.id}
                    data-pipeline={choice.id}
                    className="border-t border-border first:border-t-0"
                  >
                    {href === null ? (
                      // Not a well-formed uuid: it names nothing this app can open (R15).
                      <span className={rowClass}>{inner}</span>
                    ) : (
                      <Link
                        href={href}
                        prefetch={false}
                        className={`${rowClass} rounded-md hover:bg-surface-sunken ${FOCUS}`}
                      >
                        {inner}
                        <Icon
                          name="chevron_right"
                          size={20}
                          className="text-text-muted rtl:-scale-x-100"
                        />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {phase === 'loaded' && cursor !== null ? (
          <div className="flex max-w-[960px] justify-center">
            <button
              type="button"
              data-requires-connection=""
              disabled={!online || loadingMore}
              onClick={loadMore}
              className={`${SECONDARY_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {t.t(loadingMore ? 'records.loadingMore' : 'records.loadMore')}
            </button>
          </div>
        ) : null}
      </div>
    </CrmShell>
  );
}

/**
 * P06/17 and P06/18: "Create your first pipeline" — four templates, the
 * chosen one's stages with their probabilities and locks, and its rule. Create
 * and Start from blank are disabled: no operation creates a pipeline yet
 * (D-L194). The picker itself works, so each template's stages can be read.
 */
function TemplatePicker({ t }: { t: Translator }) {
  const [picked, setPicked] = useState<TemplateId>('b2b');
  const template = TEMPLATES.find((entry) => entry.id === picked) ?? TEMPLATES[0];
  if (template === undefined) return null;
  const name = t.t(templateKey(`pipeline.template.${template.id}.name`));
  return (
    <section
      data-testid="pipeline-index-empty"
      className="flex max-w-[960px] flex-col gap-4.5 rounded-xl border border-border bg-surface p-4.5 md:p-7"
    >
      <div className="flex flex-col gap-1.5">
        <span className="mb-1.5 flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary-text">
          <Icon name="view_kanban" size={24} />
        </span>
        <h2 className="text-h4 font-bold">{t.t('pipeline.template.title')}</h2>
        <p className="text-label font-normal text-text-2">{t.t('pipeline.template.body')}</p>
      </div>
      <div
        role="radiogroup"
        aria-label={t.t('pipeline.template.label')}
        className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5"
      >
        {TEMPLATES.map((entry) => {
          const on = entry.id === picked;
          return (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(entry.id)}
              className={`flex min-h-touch flex-col items-start gap-1.5 rounded-lg p-3.5 text-start text-text ${
                on
                  ? 'border-2 border-primary bg-primary-soft'
                  : 'border border-border-strong bg-surface hover:bg-surface-sunken'
              } ${FOCUS}`}
            >
              <span className="text-primary-text">
                <Icon name={entry.icon} size={24} />
              </span>
              <b className="text-label font-bold">
                {t.t(templateKey(`pipeline.template.${entry.id}.name`))}
              </b>
              <span className="text-meta text-text-2">
                {t.t(templateKey(`pipeline.template.${entry.id}.description`))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2.5 rounded-lg bg-surface-sunken p-3.5">
        <span className="text-caption font-bold uppercase tracking-[0.06em] text-text-muted">
          {t.t('pipeline.template.stagesIn', { name })}
        </span>
        <ul className="flex flex-wrap items-center gap-1.5">
          {template.stages.map(([stage, percent, gated]) => (
            <li
              key={stage}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-meta font-semibold"
            >
              {gated ? <Icon name="lock" size={15} className="text-text-2" /> : null}
              {t.t(templateKey(`pipeline.template.${template.id}.stage.${stage}`))}
              <span className="text-micro font-normal text-text-muted">
                {t.t('pipeline.template.percent', { percent })}
              </span>
            </li>
          ))}
        </ul>
        <p className="flex gap-1.5 text-meta text-text-2">
          <Icon name="lock" size={16} />
          {t.t(templateKey(`pipeline.template.${template.id}.rule`))}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled
          title={t.t('pipeline.template.unavailable')}
          className="h-control-lg px-5"
        >
          {t.t('pipeline.template.create', { name })}
        </Button>
        <Button variant="ghost" disabled className="h-control-lg">
          {t.t('pipeline.template.blank')}
        </Button>
        <span className="basis-full text-caption font-normal text-text-muted">
          {t.t('pipeline.template.unavailable')}
        </span>
      </div>
    </section>
  );
}
