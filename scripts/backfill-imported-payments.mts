/**
 * One-off: record the payments written in the notes of bookings imported from
 * the booking book ("no payment", "paid R1080", …) as payment lines, so their
 * outstanding balance is right.
 *
 *   npx tsx --env-file=.env.local scripts/backfill-imported-payments.mts            # dry run: prints the plan
 *   npx tsx --env-file=.env.local scripts/backfill-imported-payments.mts --apply    # writes it
 *
 * Only PAID/CONFIRMED imported bookings with no payments yet are touched, so it
 * is safe to run twice. Bookings whose notes cannot be read, or that say more
 * was paid than the booking total, are listed and skipped for staff to fix by hand.
 * Nothing about the booking itself (status, seats, tickets) changes.
 */
import { createClient } from '@supabase/supabase-js';
import { importedPaymentReference, paidFromNotes } from '../src/lib/imported-payments';

const METHOD = (process.argv.find(arg => arg.startsWith('--method='))?.split('=')[1] || 'CASH').toUpperCase();
const APPLY = process.argv.includes('--apply');
const NOTE = 'from booking-book notes';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const { data, error } = await supabase.from('bookings')
  .select('id,reference,status,total_amount,voucher_amount_used,notes,created_at,deleted_at,payments(id,status)')
  .eq('payment_method', 'IMPORTED').is('deleted_at', null).in('status', ['PAID', 'CONFIRMED']).order('reference');
if (error) throw error;

const plan: Array<{ id: string; reference: string; amount: number; paidOn: string }> = [];
const rows: string[] = [];
const skipped: string[] = [];
for (const booking of data || []) {
  const total = Number(booking.total_amount) - Number(booking.voucher_amount_used || 0);
  const notes = (booking.notes || '').replace('IMPORTED_FROM_BOOK', '').trim();
  if ((booking.payments || []).length) { skipped.push(`${booking.reference}: already has payments recorded`); continue; }
  const paid = paidFromNotes(booking.notes);
  if (paid === null) { skipped.push(`${booking.reference}: notes don't say what was paid (${JSON.stringify(notes)})`); continue; }
  if (paid > total) { skipped.push(`${booking.reference}: notes say R${paid} paid but the total is R${total} (${JSON.stringify(notes)})`); continue; }
  const paidOn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date(booking.created_at));
  rows.push(`${booking.reference.padEnd(18)} total R${total.toFixed(2).padStart(9)}  paid R${paid.toFixed(2).padStart(9)}  owes R${(total - paid).toFixed(2).padStart(9)}   notes: ${notes}`);
  if (paid > 0) plan.push({ id: booking.id, reference: booking.reference, amount: paid, paidOn });
}

console.log(rows.join('\n'));
console.log(`\n${rows.length} bookings read from their notes: ${plan.length} payment line${plan.length === 1 ? '' : 's'} to add (${METHOD}), ${rows.length - plan.length} with nothing paid (no change needed).`);
if (skipped.length) console.log(`\nSkipped, fix by hand:\n  ${skipped.join('\n  ')}`);

if (!APPLY) console.log('\nDry run: nothing written. Add --apply to record these payments.');
for (const payment of APPLY ? plan : []) {
  const { error: insertError } = await supabase.from('payments').insert({
    booking_id: payment.id, amount: payment.amount, method: METHOD, status: 'COMPLETE',
    provider_reference: importedPaymentReference(NOTE), created_at: `${payment.paidOn}T12:00:00+02:00`,
  });
  if (insertError) { console.error(`${payment.reference}: FAILED`, insertError.message); process.exitCode = 1; continue; }
  const { error: auditError } = await supabase.from('admin_audit_log').insert({ actor_id: null, actor_email: 'backfill script', action: 'RECORD_IMPORTED_PAYMENT', entity_type: 'booking', entity_id: payment.id, details: { reference: payment.reference, amount: payment.amount, method: METHOD, source: 'backfill from booking-book notes' } });
  if (auditError) console.error(`${payment.reference}: audit log not written`, auditError.message);
  console.log(`${payment.reference}: recorded R${payment.amount.toFixed(2)}`);
}
