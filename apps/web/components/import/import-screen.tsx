'use client';

import { useEffect, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId, type Translator } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { CrmShell } from '../crm/crm-shell';
import type { LanguageOption } from '../auth/language-menu';
import { declare } from '../../lib/import-model';
import { ImportUploader, type UploadFailure, type UploadView } from '../../lib/import-upload';
import { createImport } from '../../lib/imports-api';
import { ImportHistoryList } from './import-history';
import { refusalId } from './import-text';
import { UploadStep } from './upload-step';
import { useImportHistory, useProgrammes } from './use-import-history';

/**
 * `P28` — the CSV import wizard (T-0096), PART ONE: the upload step and the
 * history. The mapping, phones and run steps arrive in part two; until then
 * Continue goes nowhere and a history row cannot be opened.
 *
 * THE FILE NEVER COMES HERE. It goes from the browser to the bucket in pieces
 * (`lib/import-upload.ts`); the page parses nothing, previews nothing and
 * keeps nothing on the device (D-P21). Leaving the screen stops an upload in
 * flight (B1).
 */

type Step = 'upload' | 'mapping' | 'phones' | 'run';
const STEPS: readonly Step[] = ['upload', 'mapping', 'phones', 'run'];

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

  const [programmeId, setProgrammeId] = useState('');
  const [tooLarge, setTooLarge] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const [upload, setUpload] = useState<UploadView | null>(null);
  const uploader = useRef<ImportUploader | null>(null);
  const [hasUploader, setHasUploader] = useState(false);

  useEffect(() => {
    if (programmeId === '' && programmes.programmes.length === 1) setProgrammeId(programmes.programmes[0]?.id ?? '');
  }, [programmes.programmes, programmeId]);

  // Leaving the screen stops an upload in flight: no part keeps going to a bucket nobody is watching (B1).
  useEffect(
    () => () => {
      void uploader.current?.cancel();
    },
    [],
  );

  const failUpload = (failure: UploadFailure) => {
    if (failure.kind === 'parts' || failure.error.code === 'network') {
      setError('import.upload.failed');
      return;
    }
    setError(refusalId(failure.error));
    uploader.current = null;
    setHasUploader(false);
    setUpload(null);
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
    const next = new ImportUploader(file, created.value, setUpload, () => undefined, failUpload);
    uploader.current = next;
    setHasUploader(true);
    next.start();
  };

  const cancelUpload = async () => {
    const current = uploader.current;
    if (current === null) return;
    uploader.current = null;
    setHasUploader(false);
    setUpload(null);
    setError(null);
    await current.cancel();
  };

  const retryUpload = () => {
    setError(null);
    uploader.current?.resume();
  };

  return (
    <CrmShell t={t} locale={locale} locales={locales} current="contacts" live={live}>
      <div data-screen="P28" className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-h2">{t.t('import.wizard.title')}</h1>
          <p className="text-body-md text-text-2">{t.t('import.wizard.subtitle')}</p>
        </header>

        <StepList t={t} current="upload" />

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
          <UploadStep
            t={t}
            locale={locale}
            programmes={programmes}
            programmeId={programmeId}
            tooLarge={tooLarge}
            upload={upload}
            controls={hasUploader}
            onProgramme={setProgrammeId}
            onFile={(file) => void onFile(file)}
            onPause={() => uploader.current?.pause()}
            onResume={retryUpload}
            onRetry={retryUpload}
            onCancel={() => void cancelUpload()}
            onContinue={() => undefined}
          />
        </div>

        <ImportHistoryList
          t={t}
          locale={locale}
          history={history}
          programmes={programmes.programmes}
          canOpen={false}
          onOpen={() => undefined}
        />
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
