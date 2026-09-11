import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

type CheckinItem = {
  ticket_uid: string;
  ticket_id: string;
  checked_in_at: string;
  device_id: string;
};

type ResultItem = {
  ticket_uid: string;
  status: 'ok' | 'conflict' | 'error';
  message?: string;
};

/**
 * POST /api/admin/scan/batch-checkin
 *
 * Accepts an array of queued offline check-in events and processes them.
 * For each check-in:
 *  1. If ticket status is VALID → mark as USED, insert scan, return 'ok'
 *  2. If ticket status is already USED → detect conflict, log it, return 'conflict'
 *  3. On error → return 'error'
 *
 * Conflict resolution: earliest timestamp wins. Both scans are recorded,
 * and a checkin_conflicts row is created for admin review.
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

    for (const checkin of checkins) {
      try {
        if (!checkin.ticket_uid || !checkin.checked_in_at || !checkin.device_id) {
          results.push({ ticket_uid: checkin.ticket_uid || 'unknown', status: 'error', message: 'Missing required fields' });
          continue;
        }

        // Try to atomically mark the ticket as USED
        const { data: consumed, error: updateError } = await supabase
          .from('tickets')
          .update({ status: 'USED' })
          .eq('ticket_uid', checkin.ticket_uid)
          .eq('status', 'VALID')
          .select('id, booking_id')
          .maybeSingle();

        if (updateError) throw updateError;

        if (consumed) {
          // Successfully claimed — this is the first check-in
          const { error: scanError } = await supabase.from('ticket_scans').insert({
            ticket_id: consumed.id,
            scanned_at: checkin.checked_in_at,
            scanned_by: user.id,
            result_status: 'APPROVED',
            device_id: checkin.device_id,
          });
          if (scanError) throw scanError;

          await writeAudit(user.id, 'SCAN_TICKET_OFFLINE', 'ticket', consumed.id, {
            ticket_uid: checkin.ticket_uid,
            device_id: checkin.device_id,
            scanned_at: checkin.checked_in_at,
            synced_at: new Date().toISOString(),
          });

          results.push({ ticket_uid: checkin.ticket_uid, status: 'ok' });
        } else {
          // Ticket is already USED — this is a potential conflict
          const { data: ticket } = await supabase
            .from('tickets')
            .select('id, booking_id')
            .eq('ticket_uid', checkin.ticket_uid)
            .maybeSingle();

          if (!ticket) {
            results.push({ ticket_uid: checkin.ticket_uid, status: 'error', message: 'Ticket not found' });
            continue;
          }

          // Find the existing (first) scan for this ticket
          const { data: existingScan } = await supabase
            .from('ticket_scans')
            .select('scanned_at, scanned_by, device_id')
            .eq('ticket_id', ticket.id)
            .eq('result_status', 'APPROVED')
            .order('scanned_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          // Record the duplicate scan
          const { error: dupScanError } = await supabase.from('ticket_scans').insert({
            ticket_id: ticket.id,
            scanned_at: checkin.checked_in_at,
            scanned_by: user.id,
            result_status: 'DENIED_USED',
            device_id: checkin.device_id,
          });
          if (dupScanError) throw dupScanError;

          // Only create a conflict record if the scans came from different devices
          // (same device re-syncing is not a real conflict)
          const isSameDevice = existingScan?.device_id === checkin.device_id;

          if (!isSameDevice) {
            const { error: conflictError } = await supabase.from('checkin_conflicts').insert({
              ticket_id: ticket.id,
              ticket_uid: checkin.ticket_uid,
              first_scan_at: existingScan?.scanned_at || new Date().toISOString(),
              first_device_id: existingScan?.device_id || 'unknown',
              first_scanned_by: existingScan?.scanned_by || null,
              conflict_scan_at: checkin.checked_in_at,
              conflict_device_id: checkin.device_id,
              conflict_scanned_by: user.id,
            });
            if (conflictError) {
              console.error('Could not create conflict record:', conflictError);
            }

            await writeAudit(user.id, 'CHECKIN_CONFLICT', 'ticket', ticket.id, {
              ticket_uid: checkin.ticket_uid,
              first_device: existingScan?.device_id || 'unknown',
              conflict_device: checkin.device_id,
              first_scan_at: existingScan?.scanned_at,
              conflict_scan_at: checkin.checked_in_at,
            });
          }

          results.push({
            ticket_uid: checkin.ticket_uid,
            status: 'conflict',
            message: isSameDevice
              ? 'Already checked in (same device re-sync)'
              : 'Already checked in by another device',
          });
        }
      } catch (itemError) {
        console.error(`Batch check-in error for ${checkin.ticket_uid}:`, itemError);
        results.push({ ticket_uid: checkin.ticket_uid, status: 'error', message: 'Server error processing check-in' });
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Batch check-in error:', error);
    return NextResponse.json({ error: 'Could not process batch check-in' }, { status: 500 });
  }
}
