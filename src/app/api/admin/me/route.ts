import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';

export async function GET(request: Request) {
  try {
    const { user, role } = await requireAdmin(request);
    return NextResponse.json({ success: true, user: { id: user.id, email: user.email }, role });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    return NextResponse.json({ success: false, error: 'Could not verify staff session' }, { status: 500 });
  }
}
