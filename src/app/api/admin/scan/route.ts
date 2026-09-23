import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { checkRateLimit, cleanText } from '@/lib/request-security';
import { verifyQrToken } from '@/lib/qr-token';
import { johannesburgToday } from '@/lib/opening-rules';

export async function POST(request: Request) {
  try {
    const { user, role } = await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);
    if (!(await checkRateLimit(request, 'admin-scan', 60, 60, user.id))) return NextResponse.json({ success: false, status: 'RATE_LIMITED', error: 'Too many scans. Please wait before scanning again.' }, { status: 429 });
    const body = await request.json();
    let token = cleanText(body.token, 500);
    const ticketUid = cleanText(body.ticketUid, 80);
    const reference = cleanText(body.reference, 80);
    // Ticket QR codes contain the scanner URL. Accept both that URL and a
    // raw token so camera scans and manual/API scans use the same path.
    try {
      const qrUrl = new URL(token);
      token = qrUrl.searchParams.get('token') || token;
    } catch { /* raw QR token */ }
    if (!token && !ticketUid && !reference) return NextResponse.json({ success: false, status: 'INVALID', error: 'Enter a QR token, ticket ID, or booking reference' }, { status: 400 });
    const qrClaims = token ? verifyQrToken(token) : null;
    if (token && !qrClaims) return NextResponse.json({ success: false, status: 'INVALID', error: 'Invalid or expired ticket QR code' });
    let query = supabase.from('tickets').select('id,ticket_uid,qr_token,status,visit_date,booking_id,customers(first_name,last_name),packages(name),bookings(reference,status,voucher_issued)');
    if (token) query = query.eq('qr_token', token);
    else if (ticketUid) query = query.eq('ticket_uid', ticketUid);
    else {
      const { data: booking } = await supabase.from('bookings').select('id').eq('reference', reference).single();
      if (!booking) return NextResponse.json({ success: false, status: 'INVALID', error: 'Booking not found' });
      query = query.eq('booking_id', booking.id);
    }
    const { data: tickets, error } = await query.limit(1);
    if (error) throw error;
    const ticket = tickets?.[0];
    if (!ticket) return NextResponse.json({ success: false, status: 'INVALID', error: 'Ticket not found' });
    const booking = Array.isArray(ticket.bookings) ? ticket.bookings[0] : ticket.bookings;
    if (qrClaims && (qrClaims.bid !== ticket.booking_id || qrClaims.tid !== ticket.ticket_uid)) return NextResponse.json({ success: false, status: 'INVALID', error: 'Invalid ticket QR code' });
    if (!booking || !['PAID', 'CONFIRMED'].includes(booking.status)) return NextResponse.json({ success: false, status: 'INVALID', error: booking?.voucher_issued ? 'This ticket has been cancelled — see your rebooking voucher' : 'Ticket booking is cancelled or refunded' });
    const customer = Array.isArray(ticket.customers) ? ticket.customers[0] : ticket.customers;
    const packageName = ticket.packages?.[0]?.name;
    const { data: bookingItems } = await supabase.from('booking_items')
      .select('quantity,metadata,packages(name),huts(name)')
      .eq('booking_id', ticket.booking_id);
    const passNames = (bookingItems || []).flatMap(item => {
      const itemName = item.packages?.[0]?.name || item.metadata?.name || item.huts?.[0]?.name || 'Entrance Ticket';
      const isPerson = item.metadata?.isPerson === true || Boolean(item.packages?.length);
      return isPerson ? Array.from({ length: Number(item.quantity || 0) }, () => itemName) : [];
    });
    const { data: issuedTickets } = await supabase.from('tickets').select('id').eq('booking_id', ticket.booking_id).order('issued_at', { ascending: true });
    const ticketIndex = issuedTickets?.findIndex(item => item.id === ticket.id) ?? -1;
    const resolvedPackageName = packageName || (ticketIndex >= 0 ? passNames[ticketIndex] : undefined);
    const { data: bookingSpots, error: seatingError } = await supabase
      .from('booking_spots')
      .select('venue_spots(number,type)')
      .eq('booking_id', ticket.booking_id);
    if (seatingError) throw seatingError;
    const seating = (bookingSpots || []).map((row) => {
      const spot = Array.isArray(row.venue_spots) ? row.venue_spots[0] : row.venue_spots;
      if (!spot?.number) return null;
      return `${spot.type === 'table' ? 'Table' : 'Hut'} ${spot.number}`;
    }).filter(Boolean).join(', ');
    const base = { ticketUid: ticket.ticket_uid, ...(role !== 'SCANNER' ? { customerName: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Guest' } : {}), packageName: resolvedPackageName || 'Entrance Ticket', ...(seating ? { seating } : {}) };
    if (ticket.status !== 'VALID') return NextResponse.json({ success: false, status: ticket.status === 'USED' ? 'USED' : 'INVALID', ...base });
    if (ticket.visit_date !== johannesburgToday()) return NextResponse.json({ success: false, status: 'EXPIRED', ...base });

    const { data: consumedTicket, error: updateError } = await supabase.from('tickets')
      .update({ status: 'USED' }).eq('id', ticket.id).eq('status', 'VALID').select('id').maybeSingle();
    if (updateError) throw updateError;
    if (!consumedTicket) return NextResponse.json({ success: false, status: 'USED', ...base, error: 'Ticket has already been scanned' });
    const { error: scanError } = await supabase.from('ticket_scans').insert({ ticket_id: ticket.id, scanned_by: user.id, result_status: 'APPROVED' });
    if (scanError) throw scanError;
    await writeAudit(user.id, 'SCAN_TICKET', 'ticket', ticket.id, { ticket_uid: ticket.ticket_uid, seating: seating || null });
    return NextResponse.json({ success: true, status: 'APPROVED', ...base, scannedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Admin scan error', error);
    return NextResponse.json({ success: false, status: 'ERROR', error: 'Could not process scan' }, { status: 500 });
  }
}
