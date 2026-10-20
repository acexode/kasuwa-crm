'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Button, Stepper, type StepperStep } from '@kasuwa/ui/components';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import { BarStatus, DataHeader, DataShell, type DataLive } from '../data/data-shell';
import {
  DEFAULT_COUNTRIES,
  choicesFrom,
  declare,
  isTerminal,
  nameMapped,
  refusedFields,
  repeatedFields,
  toColumns,
  withChoice,
  withoutFields,
  type Choices,
  type DefaultCountry,
} from '../../lib/import-model';
import { ImportUploader, type UploadFailure, type UploadView } from '../../lib/import-upload';
import { cancelImport, createImport, getImport, putImportMapping, runImport, type ImportJob } from '../../lib/imports-api';
import { Icon } from '../icon';
import { ImportHistoryList } from './import-history';
import { formatCount, refusalId } from './import-text';
import { JobView, RunLoading } from './job-view';
import { MappingStep } from './mapping-step';
import { PhonesStep } from './phones-step';
import { ReviewStep } from './review-step';
import { UploadStep, type PickedFile } from './upload-step';
import { useImportJob, type PollPhase } from './use-import-job';
import { useImportHistory, useProgrammes } from './use-import-history';

/**
 * `P28` A–A6 — the CSV import wizard and its history (T-0096, restyled to the
 * export by T-0141), behind the import flag, which only the server page reads.
 *
 * TWO FRAMES, ONE SCREEN. In the admin Data management area (`data_management`,
 * T-0141) it is the design's five steps — Upload, Map fields, Clean up,
 * Review, Import — with the sticky action bar. At `/contacts/import` in the
 * CRM shell (the flag off) it keeps the four steps T-0096 shipped: the Review
 * step is D-L128 Q6's, drawn only with the counts the API returns, and the
 * contract that route is held to names four.
 *
 * ---------------------------------------------------------------------------
 * THE FILE NEVER COMES HERE. It goes from the browser to the bucket in pieces
 * (`lib/import-upload.ts`); the page parses nothing, previews nothing and
 * keeps nothing on the device (D-P21). What it knows of the file is what the
 * API says: the column names it read, a guess at each, then counts and
 * `{ row, column, code }` errors.
 *
 * SCOPE IS THE SESSION'S. The programme is chosen from the caller's own list
 * and sent as a target; no request names a scope.
 *
 * EVERY REFUSAL IS A SENTENCE. The failure states are most of this screen: a
 * refused programme, an oversized or wrong file, a part that will not go up,
 * a mapping the API turns back, a run that finds the job changed. Each is
 * translated by its code and says what to do; none prints a code.
 * ---------------------------------------------------------------------------
 */

type Step = 'upload' | 'mapping' | 'phones' | 'review' | 'run';

/** Statuses after which a wizard still on the mapping or phones step has nothing left to map. */
const DEAD_ENDS = ['rejected', 'failed', 'expired', 'cancelled'] as const;

export type ImportFrame =
  | { readonly kind: 'crm'; readonly live: readonly string[] }
  | { readonly kind: 'data'; readonly bell: boolean; readonly sections: DataLive };

export function ImportScreen({
  locale,
  messages,
  locales,
  frame,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  frame: ImportFrame;
}) {
  const t = createBundleTranslator(locale, messages);
  const designed = frame.kind === 'data';
  const steps: readonly Step[] = designed ? ['upload', 'mapping', 'phones', 'review', 'run'] : ['upload', 'mapping', 'phones', 'run'];
  const programmes = useProgrammes();
  const history = useImportHistory();

  const [fromHistory, setFromHistory] = useState(false);
  const [step, setStep] = useState<Step>('upload');
  const [programmeId, setProgrammeId] = useState('');
  const [tooLarge, setTooLarge] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const [upload, setUpload] = useState<UploadView | null>(null);
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const uploader = useRef<ImportUploader | null>(null);
  const [hasUploader, setHasUploader] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [suggested, setSuggested] = useState<Choices | null>(null);
  const [country, setCountry] = useState<DefaultCountry>('NG');
  const [readOnly, setReadOnly] = useState<ReadonlySet<string>>(new Set());
  const [reuseId, setReuseId] = useState('');
  const [fixFirst, setFixFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const [slow, setSlow] = useState(false);

  // A programme the session reaches is the only default, and only when it is the only one.
  useEffect(() => {
    if (programmeId === '' && programmes.programmes.length === 1) setProgrammeId(programmes.programmes[0]?.id ?? '');
  }, [programmes.programmes, programmeId]);

  const phase: PollPhase | null =
    importId === null ? null : step === 'run' ? 'run' : upload?.state === 'done' && job?.status === 'reading_header' ? 'header' : null;
  const poll = useImportJob(importId, phase, {
    immediate: fromHistory,
    onJob: setJob,
    onRefused: (refused) => setError(refusalId(refused)),
  });

  // The suggestion is the mapping until the person changes it; a field already refused is never in it.
  useEffect(() => {
    if (choices !== null || fromHistory || job === null || job.status !== 'awaiting_mapping' || job.headers === null) return;
    const first = withoutFields(choicesFrom(job.headers.length, job.suggestedMapping), readOnly);
    setSuggested(first);
    setChoices(first);
  }, [job, choices, fromHistory, readOnly]);

  // A file the server rejected, or a job that ended while still being mapped, has nothing left to map.
  useEffect(() => {
    if (!fromHistory && step !== 'run' && job !== null && (DEAD_ENDS as readonly string[]).includes(job.status)) setStep('run');
  }, [job, step, fromHistory]);

  // "Still connecting" while the server reads the first row (the 256 kbps NFR made visible).
  const reading = step === 'mapping' && choices === null;
  useEffect(() => {
    if (!reading) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => setSlow(true), STILL_CONNECTING_MS);
    return () => clearTimeout(timer);
  }, [reading]);

  // Leaving the screen, or the wizard, stops an upload in flight: no part keeps going to a bucket nobody is watching (B1).
  useEffect(
    () => () => {
      void uploader.current?.cancel();
    },
    [],
  );

  const leave = useCallback(() => {
    void uploader.current?.cancel();
    uploader.current = null;
    setHasUploader(false);
    setFromHistory(false);
    setStep('upload');
    setUpload(null);
    setPicked(null);
    setImportId(null);
    setJob(null);
    setChoices(null);
    setSuggested(null);
    setReuseId('');
    setFixFirst(false);
    setError(null);
    setCancelling(false);
    setTooLarge(false);
    history.reload();
  }, [history]);

  const failUpload = (failure: UploadFailure) => {
    // A part that will not go up, or a completion lost to the network, can be tried again; any other refusal starts over.
    if (failure.kind === 'parts' || failure.error.code === 'network') {
      setError('import.upload.failed');
      return;
    }
    setError(refusalId(failure.error));
    uploader.current = null;
    setHasUploader(false);
    setUpload(null);
    setPicked(null);
    setImportId(null);
  };

  const onFile = async (file: File) => {
    setError(null);
    setTooLarge(false);
    if (programmeId === '') {
      setError('import.programme.choose');
      return;
    }
    const declared = declare(file.name, file.type, file.size);
    if (!declared.ok) {
      if (declared.reason === 'file_too_large') {
        setPicked({ name: file.name, size: file.size });
        setTooLarge(true);
      } else setError('import.error.unsupported_type');
      return;
    }
    setPicked({ name: file.name, size: file.size });
    setUpload({ state: 'uploading', percent: 0, completing: false });
    const created = await createImport({ programmeId, filename: file.name, sizeBytes: file.size, contentType: declared.contentType });
    if (!created.ok) {
      setUpload(null);
      setPicked(null);
      setError(refusalId(created.error));
      return;
    }
    const next = new ImportUploader(file, created.value, setUpload, setJob, failUpload);
    uploader.current = next;
    setImportId(created.value.importId);
    setHasUploader(true);
    next.start();
  };

  const cancelUpload = async () => {
    const current = uploader.current;
    if (current === null) return;
    uploader.current = null;
    setHasUploader(false);
    setUpload(null);
    setPicked(null);
    setImportId(null);
    setJob(null);
    setError(null);
    await current.cancel();
  };

  const retryUpload = () => {
    setError(null);
    uploader.current?.resume();
  };

  const reuseMapping = async (sourceId: string) => {
    setReuseId(sourceId);
    if (sourceId === '' || importId === null) return;
    setError(null);
    const saved = await putImportMapping(importId, { fromImportId: sourceId, defaultCountry: country });
    if (!saved.ok) {
      setReuseId('');
      setError(refusalId(saved.error));
      return;
    }
    setJob(saved.value);
    if (saved.value.headers !== null && saved.value.mapping !== null) {
      setChoices(withoutFields(choicesFrom(saved.value.headers.length, saved.value.mapping.columns), readOnly));
      const savedCountry = DEFAULT_COUNTRIES.find((code) => code === saved.value.mapping?.defaultCountry);
      if (savedCountry !== undefined) setCountry(savedCountry);
    }
  };

  /** The job changed under us (a `409`): read it again, and show it if it has ended. */
  const readAgain = async () => {
    if (importId === null) return;
    const again = await getImport(importId);
    if (!again.ok) return;
    setJob(again.value);
    // A lost answer to `run` leaves the job queued or running: that is the run step too (N4).
    if (isTerminal(again.value.status) || again.value.status === 'queued' || again.value.status === 'running') setStep('run');
  };

  const start = async () => {
    if (locked.current || importId === null || choices === null) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await putImportMapping(importId, { columns: toColumns(choices), defaultCountry: country });
      if (!saved.ok) {
        const refused = refusedFields(saved.error.details);
        if (refused.length > 0) {
          setReadOnly((held) => new Set([...held, ...refused]));
          setChoices(withoutFields(choices, new Set(refused)));
        }
        setError(refusalId(saved.error));
        if (saved.error.code === 'validation_failed' || refused.length > 0) setStep('mapping');
        else if (saved.error.code === 'import_status_conflict') await readAgain();
        return;
      }
      setJob(saved.value);
      const ran = await runImport(importId);
      if (!ran.ok) {
        setError(refusalId(ran.error));
        if (ran.error.code === 'import_status_conflict') await readAgain();
        return;
      }
      setJob(ran.value);
      setCancelling(false);
      setStep('run');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  const cancelRun = async () => {
    if (importId === null) return;
    setError(null);
    const cancelled = await cancelImport(importId);
    if (!cancelled.ok) {
      setError(refusalId(cancelled.error));
      return;
    }
    setCancelling(true);
    setJob(cancelled.value);
  };

  const openFromHistory = (id: string) => {
    setError(null);
    setJob(null);
    setCancelling(false);
    setFromHistory(true);
    setImportId(id);
    setStep('run');
  };

  const reusable = history.rows.filter((row) => row.status === 'finished' && row.filename !== null && row.rawFileDeletedAt === null && row.id !== importId);
  const programmeName = programmes.programmes.find((entry) => entry.id === (job?.programmeId ?? programmeId))?.name ?? null;

  // ---------------------------------------------------------------------------
  // The sticky action bar: what the step is waiting for, and its one way on.
  // ---------------------------------------------------------------------------
  const ready = choices !== null && nameMapped(choices) && repeatedFields(choices).length === 0;
  const continueButton = (label: MessageId, disabled: boolean, onClick: () => void, testId = 'import-continue') => (
    <Button variant="primary" data-testid={testId} disabled={disabled} onClick={onClick} trailingIcon="arrow_forward" className="rtl:[&_.k-icon:last-child]:-scale-x-100">
      {t.t(label)}
    </Button>
  );
  const backButton = (onClick: () => void) => (
    <Button icon="arrow_back" disabled={busy} onClick={onClick} className="rtl:[&_.k-icon]:-scale-x-100">
      {t.t('import.back')}
    </Button>
  );

  let bar: ReactNode = null;
  if (step === 'upload') {
    bar = (
      <>
        {tooLarge ? (
          <BarStatus icon="error" tone="danger">{t.t('import.bar.smaller')}</BarStatus>
        ) : upload?.state === 'done' ? (
          <BarStatus icon="check_circle" tone="success">{t.t('import.upload.done')}</BarStatus>
        ) : (
          <BarStatus icon="hourglass_top">{t.t(upload === null ? 'import.bar.choose' : 'import.bar.wait')}</BarStatus>
        )}
        {continueButton(designed ? 'import.continue.mapping' : 'import.continue', upload?.state !== 'done', () => {
          setError(null);
          setStep('mapping');
        })}
      </>
    );
  } else if (step === 'mapping') {
    const total = job?.headers?.length ?? 0;
    bar = (
      <>
        {backButton(() => setStep('upload'))}
        {choices === null ? (
          <BarStatus icon="hourglass_top">{t.t('import.map.reading')}</BarStatus>
        ) : ready ? (
          <BarStatus icon="check_circle" tone="success">{t.t('import.bar.decided', { count: total, formatted: formatCount(locale, total) })}</BarStatus>
        ) : (
          <BarStatus icon="error" tone="danger">{t.t(nameMapped(choices) ? 'import.bar.repeated' : 'import.bar.noName')}</BarStatus>
        )}
        {continueButton('import.continue', !ready || busy, () => {
          setError(null);
          setStep('phones');
        })}
      </>
    );
  } else if (step === 'phones') {
    bar = (
      <>
        {backButton(() => setStep('mapping'))}
        <BarStatus icon="info">{t.t('import.bar.unsaved')}</BarStatus>
        {designed
          ? continueButton('import.continue.review', busy, () => {
              setError(null);
              setStep('review');
            })
          : continueButton('import.start', busy, () => void start(), 'import-start')}
      </>
    );
  } else if (step === 'review') {
    bar = (
      <>
        {backButton(() => setStep('phones'))}
        <BarStatus icon="info">{t.t('import.bar.background')}</BarStatus>
        {fixFirst
          ? continueButton('import.review.another', busy, leave, 'import-restart')
          : (
              <Button variant="primary" data-testid="import-start" disabled={busy} loading={busy} onClick={() => void start()} trailingIcon="arrow_forward" className="rtl:[&_.k-icon:last-child]:-scale-x-100">
                {t.t('import.start')}
              </Button>
            )}
      </>
    );
  } else if (job !== null) {
    const live = job.status === 'queued' || job.status === 'running';
    const canLeave = fromHistory || isTerminal(job.status);
    bar = (
      <>
        {live ? <BarStatus icon="sync">{t.t('import.bar.running')}</BarStatus> : <BarStatus icon={job.status === 'finished' ? 'check_circle' : 'info'} tone={job.status === 'finished' ? 'success' : 'muted'}>{t.t(`import.status.${job.status}` as MessageId)}</BarStatus>}
        {canLeave ? (
          fromHistory ? (
            <Button icon="arrow_back" onClick={leave} className="rtl:[&_.k-icon]:-scale-x-100">
              {t.t('import.job.back')}
            </Button>
          ) : (
            continueButton('import.report.again', false, leave, 'import-again')
          )
        ) : null}
      </>
    );
  }

  const body = (
    <div data-screen="P28" data-step-current={step} className="flex min-w-0 flex-col gap-5">
      <DataHeader title={t.t('import.wizard.title')} lede={t.t('import.wizard.subtitle')}>
        <StepList t={t} steps={steps} current={step} />
      </DataHeader>

      {error === null ? null : (
        <p
          role="alert"
          data-testid="import-error"
          className="m-0 flex items-start gap-3 rounded-lg bg-danger-soft px-5 py-4 text-body-sm text-danger-text"
        >
          <Icon name="error" size={20} className="mt-px shrink-0" />
          {t.t(error)}
        </p>
      )}

      {step === 'upload' ? (
        <UploadStep
          t={t}
          locale={locale}
          designed={designed}
          migrationHref={frame.kind === 'data' && frame.sections.migration ? '/admin/data/migration' : null}
          programmes={programmes}
          programmeId={programmeId}
          tooLarge={tooLarge}
          picked={picked}
          upload={upload}
          controls={hasUploader}
          onProgramme={(id) => {
            setProgrammeId(id);
            setReadOnly(new Set());
          }}
          onFile={(file) => void onFile(file)}
          onPause={() => uploader.current?.pause()}
          onResume={retryUpload}
          onRetry={retryUpload}
          onCancel={() => void cancelUpload()}
        />
      ) : null}
      {step === 'mapping' ? (
        <MappingStep
          t={t}
          locale={locale}
          designed={designed}
          headers={job?.headers ?? null}
          choices={choices}
          suggested={suggested}
          readOnly={readOnly}
          reusable={reusable}
          reuseId={reuseId}
          busy={busy}
          slow={slow}
          onChoice={(index, field) => setChoices((held) => (held === null ? held : withChoice(held, index, field)))}
          onReuse={(id) => void reuseMapping(id)}
        />
      ) : null}
      {step === 'phones' ? <PhonesStep t={t} designed={designed} country={country} onCountry={setCountry} /> : null}
      {step === 'review' && choices !== null ? (
        <ReviewStep
          t={t}
          locale={locale}
          headers={job?.headers ?? []}
          choices={choices}
          programmeName={programmeName}
          country={country}
          fixFirst={fixFirst}
          onFixFirst={setFixFirst}
        />
      ) : null}
      {step === 'run' ? (
        job === null ? (
          <RunLoading t={t} failed={error !== null} onLeave={leave} />
        ) : (
          <JobView
            t={t}
            locale={locale}
            job={job}
            programmeName={programmeName}
            retrying={poll.retrying}
            cancelling={cancelling}
            onCancel={() => void cancelRun()}
          />
        )
      ) : null}

      {step === 'upload' || (designed && step === 'run' && job !== null) ? (
        <ImportHistoryList t={t} locale={locale} history={history} programmes={programmes.programmes} canOpen={upload === null || upload.state === 'done'} onOpen={openFromHistory} />
      ) : null}

      {frame.kind === 'crm' && bar !== null ? (
        <div data-testid="data-action-bar" className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {bar}
        </div>
      ) : null}
    </div>
  );

  if (frame.kind === 'crm') {
    return (
      <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={frame.live}>
        {body}
      </CrmShell>
    );
  }
  return (
    <DataShell t={t} locale={locale} messages={messages} locales={locales} bell={frame.bell} current="import" live={frame.sections} footer={bar ?? undefined}>
      {body}
    </DataShell>
  );
}

/**
 * The step list (the T-0129 Stepper, to the export): numbered 26px circles
 * with inline labels and hairline connectors; the one in hand is
 * `aria-current="step"`, and each item keeps its `data-step`.
 */
function StepList({ t, steps, current }: { t: Translator; steps: readonly Step[]; current: Step }) {
  const at = steps.indexOf(current);
  const items: StepperStep[] = steps.map((step, index) => ({
    label: t.t(`import.step.${step}` as MessageId),
    state: index < at ? 'done' : index === at ? 'active' : 'todo',
    attributes: { 'data-step': step },
  }));
  return (
    <Stepper
      steps={items}
      label={t.t('import.steps.label')}
      listAttributes={{ 'data-testid': 'import-steps' }}
      compactSummary={t.t('import.steps.compact', { step: at + 1, total: steps.length, label: t.t(`import.step.${current}` as MessageId) })}
    />
  );
}
