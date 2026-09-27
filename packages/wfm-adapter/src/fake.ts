import type {
  AdherencePort,
  AdherenceSummary,
  PublishedShift,
  RequestLinkPort,
  SchedulePort,
  StaffingInterval,
  StaffingPort,
  WfmAdapter,
  WfmScope,
} from './contracts';

/**
 * In-memory fake WFM, for tests only.
 *
 * Returns exactly what a test puts in. It models no WFM logic whatsoever — no
 * Erlang maths, no tolerance windows, no roster rules — because the real system
 * already has all of that and we have not seen it (D-W1). A fake that invented
 * that behaviour would encode guesses as though they were requirements.
 */
export class FakeWfmPlatform implements WfmAdapter {
  private shifts: PublishedShift[] = [];
  private adherenceRows: AdherenceSummary[] = [];
  private staffingRows: StaffingInterval[] = [];
  private swapUrl = 'https://fake-wfm.invalid/requests';

  setShifts(shifts: PublishedShift[]): void {
    this.shifts = shifts;
  }

  setAdherence(rows: AdherenceSummary[]): void {
    this.adherenceRows = rows;
  }

  setStaffing(rows: StaffingInterval[]): void {
    this.staffingRows = rows;
  }

  private static inScope(scope: WfmScope, candidate: WfmScope): boolean {
    return scope.tenantId === candidate.tenantId && scope.programmeId === candidate.programmeId;
  }

  readonly schedules: SchedulePort = {
    getPublishedShifts: async (scope, kasuwaUserId, range) =>
      this.shifts.filter(
        (shift) =>
          FakeWfmPlatform.inScope(scope, shift.scope) &&
          shift.kasuwaUserId === kasuwaUserId &&
          shift.startsAt >= range.from &&
          shift.startsAt <= range.to,
      ),
  };

  readonly adherence: AdherencePort = {
    getAdherence: async (scope, _range, kasuwaUserIds) =>
      this.adherenceRows.filter(
        (row) =>
          FakeWfmPlatform.inScope(scope, row.scope) &&
          (kasuwaUserIds === undefined || kasuwaUserIds.includes(row.kasuwaUserId)),
      ),
  };

  readonly staffing: StaffingPort = {
    getStaffing: async (scope, range) =>
      this.staffingRows.filter(
        (row) =>
          FakeWfmPlatform.inScope(scope, row.scope) &&
          row.intervalStart >= range.from &&
          row.intervalStart <= range.to,
      ),
  };

  readonly requests: RequestLinkPort = {
    getSwapAndLeaveUrl: async () => ({ url: this.swapUrl }),
  };
}
