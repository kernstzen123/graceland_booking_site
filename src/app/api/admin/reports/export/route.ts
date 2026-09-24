import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { buildReport } from '@/lib/reports';
import { buildReportWorkbook } from '@/lib/report-workbook';
import { parseReportParams, ReportParamError } from '@/lib/report-params';

/** GET ?from&to&basis — the report as a formatted multi-sheet Excel workbook. */
export async function GET(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { from, to, basis } = parseReportParams(request);
    const report = await buildReport(from, to, basis);
    const buffer = await buildReportWorkbook(report).xlsx.writeBuffer();
    await writeAudit(user.id, 'EXPORT_REPORT', 'report', `${from}..${to}`, { basis, bookings: report.bookings.length });
    const filename = `graceland-report-${from}-to-${to}${basis === 'booked' ? '-by-booking-date' : ''}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    if (error instanceof ReportParamError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('Admin report export error', error);
    return NextResponse.json({ success: false, error: 'Could not export the report' }, { status: 500 });
  }
}
