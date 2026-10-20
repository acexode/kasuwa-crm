'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createBundleTranslator, type MessageBundle, type MessageId } from '@kasuwa/i18n/bundle';
import { Button } from '@kasuwa/ui/components';
import { Icon } from '../icon';
import { AuthShell } from './auth-shell';
import { shellStrings } from './shell-strings';
import { AUTH_COLUMN, PAGE_SUBTITLE, PAGE_TITLE } from './auth-classes';
import { Emphasis } from './rich-text';
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
    <AuthShell strings={shellStrings(t)} locales={locales} currentLocale={locale}>
      <section data-screen="P01/1c" className={AUTH_COLUMN}>
        <a
          href="/"
          className="inline-flex h-control-base items-center gap-1 self-start rounded-sm text-body-sm font-semibold text-primary-text focus-visible:ring-focus"
        >
          <Icon name="arrow_back" size={20} className="rtl:-scale-x-100" />
          {t.t('auth.sso.back')}
        </a>

        <div className="flex flex-col gap-1.5">
          <h1 className={PAGE_TITLE}>{t.t('auth.sso.title')}</h1>
          <p className={PAGE_SUBTITLE}>{t.t('auth.sso.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4.5" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId} className="text-body-sm font-semibold">
              {t.t('auth.sso.domain.label')}
            </label>
            {/* One control drawn as the export's joined field: a fixed "name@"
                segment, then the domain. The edge and the halo are the
                field's, so they follow the input's focus and error. */}
            <span
              className={`flex h-control-lg items-stretch overflow-hidden rounded-md bg-surface focus-within:field-focus ${
                failed ? 'border-2 border-danger' : 'border border-border-strong'
              }`}
            >
              <span
                aria-hidden="true"
                className="flex items-center border-e border-border bg-surface-sunken px-3 font-mono text-body-sm text-text-2"
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
                className="min-w-0 flex-1 border-0 bg-transparent px-3 font-mono text-label font-normal text-text outline-none placeholder:text-text-muted"
              />
              {failed ? <Icon name="error" size={20} className="self-center pe-3 text-danger-text" /> : null}
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
                <Emphasis
                  sentence={(value) => t.t(`auth.error.${error.code}` as MessageId, { domain: value ?? '' })}
                  values={[<strong key="domain">{domain}</strong>]}
                />
              </p>
            ) : null}
          </div>

          <Button type="submit" variant="primary" size="large" loading={pending} className="w-full">
            {t.t('auth.sso.continue')}
          </Button>
        </form>

        <a
          href="/"
          className="flex h-control-lg items-center justify-center rounded-md border border-border-strong bg-surface px-3.5 text-label text-text hover:bg-surface-sunken focus-visible:ring-focus"
        >
          {t.t('auth.sso.emailInstead')}
        </a>
        <p className="text-meta text-text-muted">{t.t('auth.sso.providers')}</p>
      </section>
    </AuthShell>
  );
}
