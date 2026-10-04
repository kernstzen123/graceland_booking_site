import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireAdmin, AdminAuthError } from '@/lib/admin-auth';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);

    const { id } = await params;
    const body = await request.json();
    const {
      title, description, badge_text, type, paid_tickets, free_tickets, pricing,
      free_meals, included_meals, valid_from, valid_to, valid_weekdays, stock_limit, max_per_booking, active
    } = body;

    const { data, error: updateError } = await supabase
      .from('specials')
      .update({
        title, description, badge_text, type, paid_tickets, free_tickets, pricing,
        free_meals, included_meals: included_meals || [], valid_from, valid_to, valid_weekdays, stock_limit, max_per_booking, active
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;
    return NextResponse.json({ special: data });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);

    const { id } = await params;

    // We archive instead of hard delete, especially if it has sales.
    const { error: deleteError } = await supabase
      .from('specials')
      .update({ archived_at: new Date().toISOString(), active: false })
      .eq('id', id);

    if (deleteError) throw deleteError;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    if (error instanceof AdminAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
