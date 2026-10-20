import { notFound } from 'next/navigation';
import { bundleMessages } from '@kasuwa/i18n';
import { HomeScreen } from '../../components/home/home-screen';
import { HOME_MESSAGE_IDS } from '../../components/home/message-ids';
import { withShellMessages } from '../../components/crm/shell-messages';
import { crmHomeEnabled, crmLiveNav, homeWidgetFlags } from '../../lib/feature-flags';
import { activeLocale, languageOptions } from '../../lib/locale';

/**
 * `P03` — Home (T-0132, D-L196): the greeting, the period and currency
 * controls, the widget grid, customise mode and the Add-widget drawer.
 *
 * Behind `crm_home`, DEFAULT OFF and read on the server: a gated ROUTE, so with
 * the flag off this is a real 404 and nothing of the screen ships. No header,
 * cookie or query string can switch it on (`lib/feature-flags.ts`). With it on,
 * this is where a signed-in browser lands (`lib/server/landing.ts`).
 *
 * The widgets are read from the BROWSER (`components/home/use-home-data.ts`):
 * the agenda is today in the browser's own zone, which a server render cannot
 * know, and the loading states are the ones a 256 kbps user lives in.
 */
export default async function HomePage() {
  if (!(await crmHomeEnabled())) {
    notFound();
  }
  const { locale } = await activeLocale();
  const [live, flags] = await Promise.all([crmLiveNav(), homeWidgetFlags()]);

  return (
    <HomeScreen
      locale={locale}
      messages={bundleMessages(locale, withShellMessages(HOME_MESSAGE_IDS, live))}
      locales={languageOptions(locale)}
      live={live}
      flags={flags}
    />
  );
}
