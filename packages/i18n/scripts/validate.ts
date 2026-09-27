import { IntlMessageFormat } from 'intl-messageformat';
import { DESIGN_MENU_LOCALES, LOCALE_SOURCES } from '../src/catalogues';
import { allLocaleReadiness, deriveSupportedLocales } from '../src/completeness';

/**
 * `pnpm i18n:validate` — the completeness gate as a command a developer can
 * run, not an assertion only CI sees.
 *
 * It prints one line per registered locale saying whether it is offered, held
 * back, or deliberately not on the menu, and it exits non-zero when a locale
 * that IS on the menu is broken in a way nobody chose.
 *
 * What it does NOT do is fail because a locale is merely unreviewed. An
 * unreviewed locale is not a broken build; it is a language that is honestly
 * not offered yet, which is the designed steady state under D-P1.
 *
 * `--probe '<message>'` validates one extra message given on the command line
 * and exits non-zero if it will not parse. It exists so the acceptance suite
 * can prove the validator rejects something — a validator only ever seen
 * passing is indistinguishable from one that validates nothing. A flag rather
 * than an environment variable, both because `@kasuwa/config` owns the
 * environment and because a probe that cannot be left set in a shell cannot
 * mislead a later run.
 */

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readProbe(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--probe');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) {
    out('--probe needs a message to validate');
    process.exit(2);
  }
  return value;
}

function probeLocale(argv: readonly string[]): string {
  const index = argv.indexOf('--probe-locale');
  return index === -1 ? 'en' : (argv[index + 1] ?? 'en');
}

function main(): void {
  const argv = process.argv.slice(2);
  const probe = readProbe(argv);

  if (probe !== undefined) {
    const locale = probeLocale(argv);
    try {
      new IntlMessageFormat(probe, locale);
    } catch (error) {
      out(`probe REJECTED for ${locale}: ${(error as Error).message}`);
      process.exit(1);
    }
    out(`probe accepted for ${locale}`);
    return;
  }

  const offered = new Set(deriveSupportedLocales());
  const menu = new Set<string>(DESIGN_MENU_LOCALES);
  let broken = 0;

  out(`${Object.keys(LOCALE_SOURCES).length} catalogue(s) registered, ${offered.size} offered.`);
  out('');

  for (const readiness of allLocaleReadiness()) {
    const { locale } = readiness;
    const state = offered.has(locale)
      ? 'offered'
      : menu.has(locale)
        ? 'HELD BACK'
        : 'not on the menu';

    out(`${locale.padEnd(6)} ${state}`);
    for (const problem of readiness.problems) {
      out(`         - ${problem}`);
    }

    // A structural defect in a language that is meant to be on the menu is a
    // build failure. Being unreviewed is not: that is the gate working.
    if (menu.has(locale) && !readiness.complete) {
      broken += 1;
    }
  }

  out('');
  if (broken > 0) {
    out(`${broken} menu language(s) have structural defects. Fix them or remove the catalogue.`);
    process.exit(1);
  }
  out('Every menu language is structurally sound. Languages held back are awaiting review (D-P1).');
}

main();
