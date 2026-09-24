import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { buildReport } from '@/lib/reports';
import { parseReportParams, ReportParamError } from '@/lib/report-params';

/** GET ?from&to&basis — every insight shown on the reports dashboard. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const { from, to, basis } = parseReportParams(request);
    const report = await buildReport(from, to, basis);
    return NextResponse.json({ success: true, report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    if (error instanceof ReportParamError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    console.error('Admin report error', error);
    return NextResponse.json({ success: false, error: 'Could not build the report' }, { status: 500 });
  }
}
