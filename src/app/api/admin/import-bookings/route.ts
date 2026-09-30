import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import { buildImportTemplate, readImportFile, type ImportRow } from '@/lib/booking-import';
import { createStaffBooking, prepareStaffBooking, StaffBookingError, type PreparedBooking } from '@/lib/staff-bookings';
import { spotHoldWindow, spotLabel, windowsOverlap } from '@/lib/seating';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 300;

type RowResult = { row: number; name: string; date: string; people: number; ok: boolean; message: string; reference?: string };

/** GET — the empty template to fill in from the booking book. */
export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const buffer = await buildImportTemplate();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="graceland-booking-import-template.xlsx"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Import template error', error);
    return NextResponse.json({ success: false, error: 'Could not create the template' }, { status: 500 });
  }
}

/**
 * POST (multipart: file, mode=check|import).
 * check: reads every row and reports what would happen, changing nothing.
 * import: creates every row that passes. Rows imported before are skipped,
 * so the same file can safely be uploaded again after fixing a few rows.
 */
export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const form = await request.formData();
    const file = form.get('file');
    const mode = form.get('mode') === 'import' ? 'import' : 'check';
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: 'Choose the spreadsheet to upload.' }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ success: false, error: 'The file is too large (2 MB at most).' }, { status: 400 });

    let rows: ImportRow[];
    try { rows = await readImportFile(await file.arrayBuffer()); } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'The file could not be read.' }, { status: 400 });
    }
    if (!rows.length) return NextResponse.json({ success: false, error: 'The spreadsheet has no bookings in it.' }, { status: 400 });
    if (rows.length > MAX_ROWS) return NextResponse.json({ success: false, error: `Import at most ${MAX_ROWS} bookings at a time.` }, { status: 400 });

    const { data: spots, error: spotsError } = await supabase.from('venue_spots').select('id,number,type').eq('active', true);
    if (spotsError) throw spotsError;
    const spotByNumber = new Map((spots || []).map(spot => [spot.number.toUpperCase(), spot]));

    // Check every row first.
    const prepared = new Map<number, PreparedBooking>();
    const results: RowResult[] = [];
    for (const row of rows) {
      const name = `${row.input.customer.firstName} ${row.input.customer.lastName}`.trim() || '(no name)';
      const result: RowResult = { row: row.row, name, date: row.input.visitDate, people: 0, ok: false, message: row.error || '' };
      results.push(result);
      if (row.error) continue;
      try {
        const unknown = row.input.spotNumbers.find(number => !spotByNumber.has(number));
        if (unknown) throw new StaffBookingError(`${unknown} is not on the seating map.`);
        const booking = await prepareStaffBooking({ ...row.input, spotIds: row.input.spotNumbers.map(number => spotByNumber.get(number)!.id) });
        prepared.set(row.row, booking);
        result.people = booking.people;
        result.ok = true;
        result.message = 'Ready to import';
      } catch (error) {
        if (!(error instanceof StaffBookingError)) throw error;
        result.message = error.message;
      }
    }
    await checkClashes(results, prepared, spots || []);

    if (mode === 'check') {
      return NextResponse.json({ success: true, mode, results, ready: results.filter(result => result.ok).length, problems: results.filter(result => !result.ok).length });
    }

    // Import every row that passed, one at a time, in the order of the sheet.
    for (const result of results) {
      const booking = prepared.get(result.row);
      if (!result.ok || !booking) continue;
      try {
        const created = await createStaffBooking(booking, { kind: 'IMPORTED', actorId: user.id, idempotencyKey: importKey(booking) });
        result.reference = created.reference;
        result.message = created.created ? 'Imported' : 'Already imported earlier (skipped)';
      } catch (error) {
        result.ok = false;
        result.message = error instanceof StaffBookingError ? error.message : 'Could not be imported. Try this row again.';
        if (!(error instanceof StaffBookingError)) console.error('Booking import row failed', result.row, error);
      }
    }
    return NextResponse.json({
      success: true, mode, results,
      imported: results.filter(result => result.ok && result.message === 'Imported').length,
      skipped: results.filter(result => result.ok && result.message !== 'Imported').length,
      problems: results.filter(result => !result.ok).length,
    });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Booking import error', error);
    return NextResponse.json({ success: false, error: 'The import failed. Nothing more was changed; try again.' }, { status: 500 });
  }
}

/** The same row always gets the same key, so importing a file twice does not duplicate bookings. */
function importKey(booking: PreparedBooking) {
  const { visitDate, customer, items, spotIds, party } = booking;
  return `import-${crypto.createHash('sha256').update(JSON.stringify({ visitDate, customer, items, spotIds: [...spotIds].sort(), slot: party?.slot || null })).digest('hex').slice(0, 40)}`;
}

/**
 * Flag rows whose hut or table is already taken at that time (by an existing
 * booking or an earlier row in the file), and days that would go over capacity.
 */
async function checkClashes(results: RowResult[], prepared: Map<number, PreparedBooking>, spots: Array<{ id: string; number: string; type: string }>) {
  const dates = [...new Set([...prepared.values()].map(booking => booking.visitDate))];
  if (!dates.length) return;
  const spotById = new Map(spots.map(spot => [spot.id, spot]));
  const [{ data: held, error: heldError }, { data: booked, error: bookedError }, { data: settings }] = await Promise.all([
    supabase.from('booking_spots').select('spot_id,visit_date,bookings!inner(status,expires_at,party_slot,customers(first_name,last_name))').in('visit_date', dates),
    supabase.from('bookings').select('visit_date,people_count,status,expires_at').in('visit_date', dates).is('deleted_at', null),
    supabase.from('business_settings').select('daily_capacity').limit(1).maybeSingle(),
  ]);
  if (heldError || bookedError) throw heldError || bookedError;
  // Rows already imported from an earlier upload are skipped, not reported as clashes with themselves.
  const keys = new Map([...prepared.entries()].map(([row, booking]) => [row, importKey(booking)]));
  const { data: existing, error: existingError } = await supabase.from('bookings').select('idempotency_key').in('idempotency_key', [...keys.values()]);
  if (existingError) throw existingError;
  const alreadyImported = new Set((existing || []).map(row => row.idempotency_key));

  const now = Date.now();
  const active = (booking: { status: string; expires_at: string | null } | null) => Boolean(booking && (['PAID', 'CONFIRMED', 'PAYMENT_PENDING'].includes(booking.status) || (booking.status === 'UNPAID' && booking.expires_at && new Date(booking.expires_at).getTime() > now)));

  const holders = new Map<string, Array<{ slot: string | null; who: string }>>();
  for (const row of (held || []) as unknown as Array<{ spot_id: string; visit_date: string; bookings: { status: string; expires_at: string | null; party_slot: string | null; customers: { first_name: string; last_name: string } | null } }>) {
    if (!active(row.bookings)) continue;
    const key = `${row.visit_date}|${row.spot_id}`;
    holders.set(key, [...(holders.get(key) || []), { slot: row.bookings.party_slot, who: [row.bookings.customers?.first_name, row.bookings.customers?.last_name].filter(Boolean).join(' ') || 'another booking' }]);
  }
  const people = new Map<string, number>();
  for (const booking of booked || []) if (active(booking)) people.set(booking.visit_date, (people.get(booking.visit_date) || 0) + Number(booking.people_count || 0));
  const capacity = Number(settings?.daily_capacity) || 500;

  for (const result of results) {
    const booking = prepared.get(result.row);
    if (!result.ok || !booking) continue;
    if (alreadyImported.has(keys.get(result.row))) { result.message = 'Already imported earlier (will be skipped)'; continue; }
    for (const spotId of booking.spotIds) {
      const spot = spotById.get(spotId)!;
      const mine = spotHoldWindow(spot.type, booking.party?.slot);
      const clash = (holders.get(`${booking.visitDate}|${spotId}`) || []).find(other => windowsOverlap(mine, spotHoldWindow(spot.type, other.slot)));
      if (clash) {
        result.ok = false;
        result.message = `${spotLabel(spot.type, spot.number)} is already booked by ${clash.who}${clash.slot ? ` (party ${clash.slot})` : ' for the whole day'}.`;
        prepared.delete(result.row);
        break;
      }
    }
    if (!result.ok) continue;
    const total = (people.get(booking.visitDate) || 0) + booking.people;
    if (total > capacity) {
      result.ok = false;
      result.message = `${booking.visitDate} would have ${total} people, over the daily capacity of ${capacity}.`;
      prepared.delete(result.row);
      continue;
    }
    people.set(booking.visitDate, total);
    for (const spotId of booking.spotIds) {
      const key = `${booking.visitDate}|${spotId}`;
      holders.set(key, [...(holders.get(key) || []), { slot: booking.party?.slot || null, who: `${result.name} (row ${result.row})` }]);
    }
  }
}
