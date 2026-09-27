import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { createTranslator } from '@kasuwa/i18n';
import { LiteModeProvider, LITE_COOKIE } from '../components/auth/lite-mode';
import { activeLocale } from '../lib/locale';
import './globals.css';

/**
 * App shell.
 *
 * `lang` and `dir` are set from the request, not hard-coded. RTL is a LAYOUT
 * MODE, not a translation: proving it on one screen early costs an attribute,
 * and retrofitting it across thirty screens is a project. Every screen in this
 * app lays out with logical properties (`ms-`, `me-`, `start`, `end`) so that
 * `dir="rtl"` is the only change needed — render any P01 route with
 * `?locale=ar` to see it.
 *
 * Arabic is REGISTERED and not OFFERED. It is not on the language menu, and
 * `?locale=ar` sets no cookie; it exists so RTL can be exercised against real
 * strings rather than against a specimen. See `packages/i18n/CLAUDE.md`.
 */
export const metadata: Metadata = {
  title: 'Kasuwa',
  description: 'CRM and contact centre, built in Africa',
};

/**
 * `maximum-scale` is deliberately absent. Blocking zoom fails WCAG 2.2 AA
 * (1.4.4 Resize Text) and it is the single most common accessibility defect in
 * mobile web apps, added by people trying to stop iOS zooming on focus — which
 * a 16 px field size already prevents.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await activeLocale();
  const t = createTranslator(locale);
  const store = await cookies();
  const lite = store.get(LITE_COOKIE)?.value === '1';

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-focus"
        >
          {t.t('nav.skipToContent')}
        </a>
        <main id="main">
          <LiteModeProvider initial={lite}>{children}</LiteModeProvider>
        </main>
      </body>
    </html>
  );
}
