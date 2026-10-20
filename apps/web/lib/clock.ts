import { dateFormatter } from './date-locale';
import { zoneAbbreviation } from './zone-name';

/**
 * The time of day and the zone it is in, as every record, list and the board
 * draw them (T-0062, T-0143). Apart from `components/record/record-core`
 * (T-0145), which re-exports these, so a screen that shows only "last synced"
 * does not ship the record helpers with it. Stored in UTC; shown in the
 * browser's zone, the one the person reads their clock in.
 */

/** The time of day with the zone it is in ("09:12 WAT"), for "last synced". */
export function formatClock(locale: string, at: Date): string {
  const zone = zoneName(locale, at);
  const clock = formatTime(locale, at.toISOString());
  return zone === '' ? clock : `${clock} ${zone}`;
}

/**
 * The time of day on a 24-hour clock ("14:02"), as the P05 timeline draws it:
 * the day is the group heading above it. In the browser's zone.
 */
export function formatTime(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return dateFormatter(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/**
 * The browser's zone as people there name it ("WAT", "EAT", "SAST"), for the
 * timeline's header: the abbreviation in every locale (`lib/zone-name.ts`, T-0144).
 */
export function zoneName(locale: string, at: Date = new Date()): string {
  return zoneAbbreviation(locale, at);
}
