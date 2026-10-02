'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { LINK, PRIMARY_BUTTON, SECONDARY_BUTTON } from './button-classes';
import { lookupSso, type ScreenError } from '../../lib/auth-api';
import type { LanguageOption } from './language-menu';

export function SsoScreen({
  messages,
  locale,
  locales,
}: {
  messages: MessageBundle;
  locale: string;
  locales: readonly LanguageOption[];
}) {
  const t = createBundleTranslator(locale, messages);
  const fieldId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);

  const [domain, setDomain] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ScreenError | undefined>(undefined);

  useEffect(() => {
    if (error !== undefined) {
      errorRef.current?.focus();
    }
  }, [error]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (pending) return;

      setError(undefined);
      setPending(true);
      const result = await lookupSso(domain);
      setPending(false);

      if (result.ok) {
        window.location.assign(result.value.redirectUrl);
        return;
      }
      setError(result.error);
    },
    [domain, pending],
  );

  const failed = error !== undefined;

  return (
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale} showPanel={false}>
      <section data-screen="P01/1c" className="flex w-full max-w-lg flex-col gap-5">
        <a href="/" className={`${LINK} inline-flex min-h-touch items-center gap-1 self-start no-underline`}>
          <Icon name="arrow_back" />
          {t.t('auth.sso.back')}
        </a>

        <div className="flex flex-col gap-2">
          <h1 className="text-h3 text-text">{t.t('auth.sso.title')}</h1>
          <p className="text-body-sm text-text-2">{t.t('auth.sso.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2" htmlFor={fieldId}>
            <span className="text-body-sm font-semibold">{t.t('auth.sso.domain.label')}</span>
            <span className="flex items-stretch overflow-hidden rounded-md border border-border-strong bg-surface aria-[invalid=true]:border-danger" aria-invalid={failed}>
              <span
                aria-hidden="true"
                className="flex min-h-touch items-center border-e border-border bg-surface-sunken px-3 font-mono text-body-sm text-text-2"
              >
                {t.t('auth.sso.domain.prefix')}
              </span>
              <input
                id={fieldId}
                name="domain"
                inputMode="url"
                autoComplete="url"
                required
                placeholder={t.t('auth.sso.domain.placeholder')}
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                aria-invalid={failed}
                aria-describedby={failed ? `${fieldId}-error` : undefined}
                className="min-h-touch min-w-0 flex-1 border-0 bg-surface px-3 font-mono text-body-md text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
              />
              {failed ? <Icon name="error" className="self-center pe-3 text-danger-text" /> : null}
            </span>

            {failed ? (
              <p
                id={`${fieldId}-error`}
                ref={errorRef}
                role="alert"
                tabIndex={-1}
                data-testid="sso-error"
                data-error-code={error.code}
                className="text-body-sm text-danger-text"
              >
                {t.t(`auth.error.${error.code}` as MessageId, { domain })}
              </p>
            ) : null}
          </label>

          <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
            {t.t('auth.sso.continue')}
          </button>
        </form>

        <a href="/" className={SECONDARY_BUTTON}>
          {t.t('auth.sso.emailInstead')}
        </a>
        <p className="text-caption text-text-muted">{t.t('auth.sso.providers')}</p>
      </section>
    </AuthShell>
  );
}
