import { isIsoDate, daysBetween, MAX_REPORT_DAYS, type ReportBasis } from '@/lib/reports';

export class ReportParamError extends Error {}

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=visit|booked from a report request. */
export function parseReportParams(request: Request): { from: string; to: string; basis: ReportBasis } {
  const params = new URL(request.url).searchParams;
  const from = params.get('from');
  const to = params.get('to');
  const basis: ReportBasis = params.get('basis') === 'booked' ? 'booked' : 'visit';
  if (!isIsoDate(from) || !isIsoDate(to)) throw new ReportParamError('Choose a valid start and end date.');
  if (to < from) throw new ReportParamError('The end date must be on or after the start date.');
  if (daysBetween(from, to) > MAX_REPORT_DAYS) throw new ReportParamError('Reports can cover at most three years at a time.');
  return { from, to, basis };
}
