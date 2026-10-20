import { adminBellLive } from '../components/admin/live-nav';
import type { DataLive } from '../components/data/data-shell';
import { crmDuplicatesEnabled, crmImportEnabled, crmRecordsEnabled, dataManagement, type DataManagement } from './feature-flags';

/**
 * What a P28 Data management page needs from the server (T-0141): the flags,
 * which sub-nav sections are live (each a link only where its screen is on,
 * so no entry leads to a 404) and whether the bell is drawn. Server only.
 */
export interface DataPage {
  readonly flags: DataManagement;
  readonly sections: DataLive;
  readonly bell: boolean;
}

export async function dataPage(): Promise<DataPage> {
  const [flags, records, importOn, duplicatesOn, bell] = await Promise.all([
    dataManagement(),
    crmRecordsEnabled(),
    crmImportEnabled(),
    crmDuplicatesEnabled(),
    adminBellLive(),
  ]);
  return {
    flags,
    bell,
    sections: {
      import: flags.area && records && importOn,
      duplicates: flags.area && records && duplicatesOn,
      migration: flags.area && flags.migration,
      exports: flags.area && flags.exports,
      requests: flags.area && flags.requests,
    },
  };
}
