import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

type CheckinItem = {
  ticket_uid: string;
  ticket_id: string;
  checked_in_at: string;
  device_id: string;
};

/**
 * ok: checked in. conflict: already checked in (maybe by another device).
 * rejected: the ticket was not valid when it was scanned (cancelled, refunded or
 * for another day); staff are alerted, since the guest may already be inside.
 * error: could not be processed; the device will retry.
 */
type ResultItem = {
  ticket_uid: string;
  status: 'ok' | 'conflict' | 'rejected' | 'error';
  message?: string;
};

type TicketRow = { id: string; ticket_uid: string; status: string; visit_date: string; bookings: { status: string } | Array<{ status: string }> | null };

const johannesburgDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(iso));

/**
 * POST /api/admin/scan/batch-checkin
 *
 * Processes check-ins that scanners queued while offline. Tickets are loaded
 * and marked USED in bulk; each check-in is checked the same way as an online
 * scan: the booking must still be paid and the ticket must be for the day it
 * was scanned. The first sync for a ticket wins; later ones are recorded as
 * duplicates (with a check-in alert if they came from another device).
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER', 'SCANNER']);

    const body = await request.json();
    const checkins: CheckinItem[] = body.checkins;

    if (!Array.isArray(checkins) || checkins.length === 0) {
      return NextResponse.json({ error: 'No check-in events provided' }, { status: 400 });
    }

    if (checkins.length > 500) {
      return NextResponse.json({ error: 'Too many check-in events (max 500)' }, { status: 400 });
    }

    const results: ResultItem[] = [];
    // Earliest scan per ticket; later scans of the same ticket in this batch are duplicates.
    const valid = checkins
      .filter(item => {
        const ok = typeof item?.ticket_uid === 'string' && item.ticket_uid && typeof item.device_id === 'string' && item.device_id && !Number.isNaN(Date.parse(item.checked_in_at));
        if (!ok) results.push({ ticket_uid: item?.ticket_uid || 'unknown', status: 'error', message: 'Missing required fields' });
        return ok;
      })
      .sort((a, b) => a.checked_in_at.localeCompare(b.checked_in_at));
    const uids = [...new Set(valid.map(item => item.ticket_uid))];

    const { data: ticketRows, error: ticketError } = await supabase
      .from('tickets')
      .select('id,ticket_uid,status,visit_date,bookings(status)')
      .in('ticket_uid', uids);
    if (ticketError) throw ticketError;
    const tickets = new Map((ticketRows as TicketRow[] || []).map(ticket => [ticket.ticket_uid, ticket]));

    // Decide what each ticket should get, then claim all the valid ones in one update.
    const toClaim: string[] = [];
    const rejectReason = new Map<string, string>();
    const firstScan = new Map<string, CheckinItem>();
    for (const item of valid) {
      if (firstScan.has(item.ticket_uid)) continue;
      firstScan.set(item.ticket_uid, item);
      const ticket = tickets.get(item.ticket_uid);
      if (!ticket) continue;
      const booking = Array.isArray(ticket.bookings) ? ticket.bookings[0] : ticket.bookings;
      if (!booking || !['PAID', 'CONFIRMED'].includes(booking.status)) rejectReason.set(item.ticket_uid, 'Booking was cancelled or refunded');
      else if (ticket.status === 'CANCELLED') rejectReason.set(item.ticket_uid, 'Ticket was cancelled');
      else if (ticket.visit_date !== johannesburgDate(item.checked_in_at)) rejectReason.set(item.ticket_uid, `Ticket is for ${ticket.visit_date}, not the day it was scanned`);
      else if (ticket.status === 'VALID') toClaim.push(item.ticket_uid);
    }

    const claimed = new Set<string>();
    if (toClaim.length) {
      const { data: updated, error: updateError } = await supabase
        .from('tickets').update({ status: 'USED' }).in('ticket_uid', toClaim).eq('status', 'VALID').select('ticket_uid');
      if (updateError) throw updateError;
      (updated || []).forEach(row => claimed.add(row.ticket_uid));
    }

    // Earlier approved scans of tickets that were already used, to tell same-device re-syncs from real duplicates.
    const alreadyUsedIds = [...firstScan.keys()].filter(uid => !claimed.has(uid) && !rejectReason.has(uid) && tickets.has(uid)).map(uid => tickets.get(uid)!.id);
    const firstApproved = new Map<string, { scanned_at: string; scanned_by: string | null; device_id: string | null }>();
    if (alreadyUsedIds.length) {
      const { data: scans, error: scanLoadError } = await supabase.from('ticket_scans')
        .select('ticket_id,scanned_at,scanned_by,device_id').in('ticket_id', alreadyUsedIds).eq('result_status', 'APPROVED').order('scanned_at', { ascending: true });
      if (scanLoadError) throw scanLoadError;
      for (const scan of scans || []) if (!firstApproved.has(scan.ticket_id)) firstApproved.set(scan.ticket_id, scan);
    }

    const scanRows: Array<Record<string, unknown>> = [];
    const alerts: Array<Record<string, unknown>> = [];
    for (const item of valid) {
      const ticket = tickets.get(item.ticket_uid);
      if (!ticket) { results.push({ ticket_uid: item.ticket_uid, status: 'rejected', message: 'Ticket not found' }); continue; }
      const isFirst = firstScan.get(item.ticket_uid) === item;
      const reason = rejectReason.get(item.ticket_uid);
      if (isFirst && reason) {
        scanRows.push({ ticket_id: ticket.id, scanned_at: item.checked_in_at, scanned_by: user.id, result_status: 'DENIED_INVALID', device_id: item.device_id });
        // The guest was let in offline on a ticket that was not valid: alert staff.
        alerts.push({ ticket_id: ticket.id, ticket_uid: item.ticket_uid, first_scan_at: item.checked_in_at, first_device_id: item.device_id, first_scanned_by: user.id, conflict_scan_at: item.checked_in_at, conflict_device_id: item.device_id, conflict_scanned_by: user.id, notes: `Checked in offline, but not valid: ${reason}.` });
        results.push({ ticket_uid: item.ticket_uid, status: 'rejected', message: reason });
        continue;
      }
      if (isFirst && claimed.has(item.ticket_uid)) {
        scanRows.push({ ticket_id: ticket.id, scanned_at: item.checked_in_at, scanned_by: user.id, result_status: 'APPROVED', device_id: item.device_id });
        results.push({ ticket_uid: item.ticket_uid, status: 'ok' });
        continue;
      }
      // Already used (earlier sync, another device, or an earlier scan in this batch).
      const earlier = firstApproved.get(ticket.id) || (claimed.has(item.ticket_uid) ? { scanned_at: firstScan.get(item.ticket_uid)!.checked_in_at, scanned_by: user.id, device_id: firstScan.get(item.ticket_uid)!.device_id } : null);
      const sameDevice = earlier?.device_id === item.device_id;
      scanRows.push({ ticket_id: ticket.id, scanned_at: item.checked_in_at, scanned_by: user.id, result_status: 'DENIED_USED', device_id: item.device_id });
      if (!sameDevice) {
        alerts.push({ ticket_id: ticket.id, ticket_uid: item.ticket_uid, first_scan_at: earlier?.scanned_at || item.checked_in_at, first_device_id: earlier?.device_id || 'unknown', first_scanned_by: earlier?.scanned_by || null, conflict_scan_at: item.checked_in_at, conflict_device_id: item.device_id, conflict_scanned_by: user.id });
      }
      results.push({ ticket_uid: item.ticket_uid, status: 'conflict', message: sameDevice ? 'Already checked in (same device re-sync)' : 'Already checked in by another device' });
    }

    if (scanRows.length) {
      const { error: scanError } = await supabase.from('ticket_scans').insert(scanRows);
      if (scanError) throw scanError;
    }
    if (alerts.length) {
      const { error: alertError } = await supabase.from('checkin_conflicts').insert(alerts);
      if (alertError) console.error('Could not create check-in alerts', alertError);
    }
    const count = (status: ResultItem['status']) => results.filter(result => result.status === status).length;
    await writeAudit(user.id, 'SYNC_OFFLINE_SCANS', 'ticket', `${results.length} scans`, {
      checked_in: count('ok'), duplicates: count('conflict'), rejected: count('rejected'), errors: count('error'),
      rejected_tickets: results.filter(result => result.status === 'rejected').map(result => result.ticket_uid),
      devices: [...new Set(valid.map(item => item.device_id))],
    });

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Batch check-in error:', error);
    return NextResponse.json({ error: 'Could not process batch check-in' }, { status: 500 });
  }
}
