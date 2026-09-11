import { NextResponse } from 'next/server';
import { requireAdmin, AdminAuthError, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const { id } = await params;
    const { reason } = await request.json();
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 300) return NextResponse.json({ success: false, error: 'A short reason is required to void a voucher.' }, { status: 400 });
    const { data: credit, error: loadError } = await supabase.from('booking_credits').select('id,credit_code,status,remaining_balance').eq('id', id).single();
    if (loadError || !credit) return NextResponse.json({ success: false, error: 'Voucher not found' }, { status: 404 });
    if (credit.status === 'void') return NextResponse.json({ success: false, error: 'Voucher is already void' }, { status: 400 });
    const { error: updateError } = await supabase.from('booking_credits').update({ status: 'void' }).eq('id', id).eq('status', 'active');
    if (updateError) throw updateError;
    const { error: logError } = await supabase.from('credit_void_log').insert({ credit_id: id, voided_by: user.id, reason: reason.trim() });
    if (logError) throw logError;
    await writeAudit(user.id, 'VOID_VOUCHER', 'booking_credit', id, { code: credit.credit_code, reason: reason.trim(), remaining_balance: credit.remaining_balance });
    return NextResponse.json({ success: true, message: 'Voucher voided successfully' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Voucher void error', error);
    return NextResponse.json({ success: false, error: 'Could not void voucher' }, { status: 500 });
  }
}
