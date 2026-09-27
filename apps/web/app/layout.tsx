import type { Metadata } from 'next';
import { createTranslator } from '@kasuwa/i18n';
import './globals.css';

/**
 * App shell.
 *
 * Deliberately almost empty. The real shell — navigation, command palette,
 * global search, agent state selector, low-bandwidth toggle — is Agent 11's
 * work from the Claude Design output (Prompt 0 then Prompts 1–3). Building a
 * throwaway shell here would give them something to argue with instead of a
 * blank page.
 *
 * `lang` is hard-coded to the default locale for now: locale negotiation
 * belongs with real auth and the tenant's `locale_default`, neither of which
 * exists yet.
 */
export const metadata: Metadata = {
  title: 'Kasuwa',
  description: 'CRM and contact centre, built in Africa',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const t = createTranslator('en-NG');
  return (
    <html lang="en-NG">
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:ring-2 focus:ring-focus"
        >
          {t.t('nav.skipToContent')}
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
