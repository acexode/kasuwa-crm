'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { SECONDARY_BUTTON } from '../auth/button-classes';
import { STILL_CONNECTING_MS } from '../admin/use-resource';
import {
  DEFAULT_COUNTRIES,
  choicesFrom,
  declare,
  isTerminal,
  refusedFields,
  toColumns,
  withChoice,
  withoutFields,
  type Choices,
  type DefaultCountry,
} from '../../lib/import-model';
import { ImportUploader, type UploadFailure, type UploadView } from '../../lib/import-upload';
import { cancelImport, createImport, getImport, putImportMapping, runImport, type ImportJob } from '../../lib/imports-api';
import { ImportHistoryList } from './import-history';
import { refusalId } from './import-text';
import { JobView } from './job-view';
import { MappingStep } from './mapping-step';
import { PhonesStep } from './phones-step';
import { UploadStep } from './upload-step';
import { useImportJob, type PollPhase } from './use-import-job';
import { useImportHistory, useProgrammes } from './use-import-history';

/**
 * `P28` — the CSV import wizard and its history (T-0096), behind the import flag,
 * which only the server page reads. Four steps (I2): upload, mapping, phones
 * and duplicates, the run and its report. The design's dry-run "review" step
 * is gone (D-L128 Q6): an import runs once and reports counts and row errors.
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

type Step = 'upload' | 'mapping' | 'phones' | 'run';
const STEPS: readonly Step[] = ['upload', 'mapping', 'phones', 'run'];

/** Statuses after which a wizard still on the mapping or phones step has nothing left to map. */
const DEAD_ENDS = ['rejected', 'failed', 'expired', 'cancelled'] as const;

export function ImportScreen({
  locale,
  messages,
  locales,
  live,
}: {
  locale: string;
  messages: MessageBundle;
  locales: readonly LanguageOption[];
  live: readonly string[];
}) {
  const t = createBundleTranslator(locale, messages);
  const programmes = useProgrammes();
  const history = useImportHistory();

  const [fromHistory, setFromHistory] = useState(false);
  const [step, setStep] = useState<Step>('upload');
  const [programmeId, setProgrammeId] = useState('');
  const [tooLarge, setTooLarge] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const [upload, setUpload] = useState<UploadView | null>(null);
  const uploader = useRef<ImportUploader | null>(null);
  const [hasUploader, setHasUploader] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [country, setCountry] = useState<DefaultCountry>('NG');
  const [readOnly, setReadOnly] = useState<ReadonlySet<string>>(new Set());
  const [reuseId, setReuseId] = useState('');
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
    setChoices(withoutFields(choicesFrom(job.headers.length, job.suggestedMapping), readOnly));
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
    setImportId(null);
    setJob(null);
    setChoices(null);
    setReuseId('');
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
      if (declared.reason === 'file_too_large') setTooLarge(true);
      else setError('import.error.unsupported_type');
      return;
    }
    setUpload({ state: 'uploading', percent: 0, completing: false });
    const created = await createImport({ programmeId, filename: file.name, sizeBytes: file.size, contentType: declared.contentType });
    if (!created.ok) {
      setUpload(null);
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

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div data-screen="P28" className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-h2">{t.t('import.wizard.title')}</h1>
          <p className="text-body-md text-text-2">{t.t('import.wizard.subtitle')}</p>
        </header>

        <StepList t={t} current={step} />

        {error === null ? null : (
          <p
            role="alert"
            data-testid="import-error"
            className="flex items-start gap-2 rounded-lg border border-danger bg-danger-soft p-3 text-body-sm text-danger-text"
          >
            <Icon name="error" size="sm" />
            {t.t(error)}
          </p>
        )}

        <div className="rounded-lg border border-border bg-surface p-4">
          {step === 'upload' ? (
            <UploadStep
              t={t}
              locale={locale}
              programmes={programmes}
              programmeId={programmeId}
              tooLarge={tooLarge}
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
              onContinue={() => {
                setError(null);
                setStep('mapping');
              }}
            />
          ) : null}
          {step === 'mapping' ? (
            <MappingStep
              t={t}
              locale={locale}
              headers={job?.headers ?? null}
              choices={choices}
              readOnly={readOnly}
              reusable={reusable}
              reuseId={reuseId}
              busy={busy}
              slow={slow}
              onChoice={(index, field) => setChoices((held) => (held === null ? held : withChoice(held, index, field)))}
              onReuse={(id) => void reuseMapping(id)}
              onContinue={() => {
                setError(null);
                setStep('phones');
              }}
            />
          ) : null}
          {step === 'phones' ? (
            <PhonesStep t={t} country={country} busy={busy} onCountry={setCountry} onBack={() => setStep('mapping')} onStart={() => void start()} />
          ) : null}
          {step === 'run' ? (
            job === null ? (
              <RunLoading t={t} failed={error !== null} onLeave={leave} />
            ) : (
              <JobView
                t={t}
                locale={locale}
                job={job}
                retrying={poll.retrying}
                cancelling={cancelling}
                onCancel={() => void cancelRun()}
                onLeave={leave}
                leaveLabel={fromHistory ? 'import.job.back' : 'import.report.again'}
                canLeave={fromHistory || isTerminal(job.status)}
              />
            )
          ) : null}
        </div>

        {step === 'upload' ? <ImportHistoryList t={t} locale={locale} history={history} programmes={programmes.programmes} canOpen={upload === null || upload.state === 'done'} onOpen={openFromHistory} /> : null}
      </div>
    </CrmShell>
  );
}

/** A labelled list of the four steps; the one in hand is `aria-current="step"`. */
function StepList({ t, current }: { t: Translator; current: Step }) {
  const at = STEPS.indexOf(current);
  return (
    <ol data-testid="import-steps" aria-label={t.t('import.steps.label')} className="grid grid-cols-4 gap-1">
      {STEPS.map((step, index) => (
        <li
          key={step}
          data-step={step}
          {...(step === current ? { 'aria-current': 'step' as const } : {})}
          className={`flex min-w-0 flex-col items-center gap-1 rounded-md p-2 text-center text-caption font-semibold ${
            step === current ? 'bg-primary text-on-primary' : index < at ? 'bg-primary-soft text-primary-text' : 'bg-surface-sunken text-text-2'
          }`}
        >
          <span aria-hidden="true" className="flex h-6 items-center text-body-sm font-bold">
            {index < at ? <Icon name="check" size="sm" /> : index + 1}
          </span>
          <span className="max-w-full break-words">{t.t(`import.step.${step}` as MessageId)}</span>
        </li>
      ))}
    </ol>
  );
}

/** An import opened from the history that has not been read yet, or could not be. */
function RunLoading({ t, failed, onLeave }: { t: Translator; failed: boolean; onLeave: () => void }) {
  return (
    <section aria-busy={!failed} className="flex flex-col gap-3">
      {failed ? null : (
        <p role="status" className="text-body-md text-text-2">
          {t.t('import.job.loading')}
        </p>
      )}
      <div>
        <button type="button" onClick={onLeave} className={SECONDARY_BUTTON}>
          {t.t('import.job.back')}
        </button>
      </div>
    </section>
  );
}
