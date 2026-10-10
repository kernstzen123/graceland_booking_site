import 'server-only';
/**
 * Bookings made by staff rather than by the customer online:
 * - OFFICE: taken over the phone or at the office ("Add booking"). Paid ones
 *   get their QR tickets emailed as usual; unpaid ones get EFT instructions.
 * - IMPORTED: copied over from the paper booking book. They are marked
 *   IMPORTED, count towards capacity and seating like any booking, and get
 *   tickets so the gate can check them in by name, phone or email, but no
 *   tickets are ever emailed for them.
 * Both go through the same database function as online bookings, so capacity
 * and hut clashes (including party time slots) are checked the same way.
 */
import crypto from 'crypto';
import { supabase } from '@/lib/supabase';
import { writeAudit } from '@/lib/admin-auth';
import { validateBookableDate } from '@/lib/closed-dates';
import { getPartySlots, type PartyDetails } from '@/lib/parties';
import { BOOKABLE_ITEMS, calculateServerTotal, validatePartyFields } from '@/lib/pricing';
import { getCurrentPrices } from '@/lib/price-store';
import { cleanText, isValidEmail } from '@/lib/request-security';
import { customerError } from '@/lib/public-errors';
import { emailTicketsOnce, generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/mailer';
import { sendEftInstructions } from '@/lib/eft-email';
import { STAFF_HOLD_UNTIL } from '@/lib/booking-holds';

/** Payment method recorded on imported bookings; the gate checks these in by name. */
export const IMPORTED_PAYMENT_METHOD = 'IMPORTED';
export const IMPORTED_NOTE = 'IMPORTED_FROM_BOOK';
export const OFFICE_PAYMENT_METHODS = {
  CASH: { code: 'OFFICE_CASH', label: 'Cash' },
  CARD: { code: 'OFFICE_CARD', label: 'Card machine' },
  EFT: { code: 'OFFICE_EFT', label: 'EFT received' },
} as const;
export type OfficePaymentKey = keyof typeof OFFICE_PAYMENT_METHODS;

/** A problem with the booking that staff can fix; the message is safe to show. */
export class StaffBookingError extends Error {}

export type StaffBookingInput = {
  visitDate: string;
  customer: { firstName: string; lastName: string; email?: string; phone?: string };
  /** Day-visitor tickets plus 'hut-covered' / 'hut-shaded' (paid huts and tables). */
  selections: Record<string, number>;
  party?: PartyDetails;
  spotIds: string[];
  /** Anything staff want kept on the booking (shown on the booking's details). */
  notes?: string;
};

export type PreparedBooking = Awaited<ReturnType<typeof prepareStaffBooking>>;

/** Check a staff booking and work out its items, total and headcount. Throws StaffBookingError. */
export async function prepareStaffBooking(input: StaffBookingInput) {
  const visitDate = String(input.visitDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) throw new StaffBookingError('Enter the visit date.');
  try { await validateBookableDate(visitDate); } catch (error) { throw new StaffBookingError(error instanceof Error ? error.message : 'That date cannot be booked.'); }

  const firstName = cleanText(input.customer?.firstName, 80);
  const lastName = cleanText(input.customer?.lastName, 80);
  const email = cleanText(input.customer?.email, 254).toLowerCase();
  const phone = cleanText(input.customer?.phone, 40);
  if (!firstName || !lastName) throw new StaffBookingError('Enter the customer\'s first name and surname.');
  if (email && !isValidEmail(email)) throw new StaffBookingError(`"${email}" is not a valid email address.`);
  if (!email && !phone) throw new StaffBookingError('Enter a phone number or an email address, so the gate can find the booking.');

  const selections: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.selections || {})) {
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 500) throw new StaffBookingError('Quantities must be whole numbers.');
    if (quantity === 0) continue;
    if (!BOOKABLE_ITEMS[key]) throw new StaffBookingError(`Unknown item: ${key}`);
    selections[key] = quantity;
  }

  let party: PartyDetails | undefined;
  if (input.party?.enabled) {
    try { party = validatePartyFields(input.party); } catch (error) { throw new StaffBookingError(error instanceof Error ? error.message : 'Check the party details.'); }
    if (!['option-1', 'option-2'].includes(party.option)) throw new StaffBookingError('Choose party option 1 or 2.');
    if (party.children < 1) throw new StaffBookingError('Enter the number of party children.');
    if (!getPartySlots(visitDate).includes(party.slot as never)) throw new StaffBookingError(`There is no ${party.slot || 'party'} time slot on ${visitDate}. Slots that day: ${getPartySlots(visitDate).join(', ') || 'none'}.`);
  }

  const people = Object.entries(selections).reduce((sum, [key, qty]) => sum + (BOOKABLE_ITEMS[key].isPerson ? qty : 0), 0)
    + (party ? party.children + party.adults + party.additionalChildren : 0);
  if (people === 0) throw new StaffBookingError('Add at least one person.');

  // Seating: a party includes one hut; any other huts and tables are paid extras.
  const huts = (selections['hut-covered'] || 0) + (party ? 1 : 0);
  const tables = selections['hut-shaded'] || 0;
  const spotIds = [...new Set((input.spotIds || []).filter(id => typeof id === 'string'))];
  if (spotIds.length) {
    const { data: spots, error } = await supabase.from('venue_spots').select('id,type').in('id', spotIds).eq('active', true);
    if (error) throw error;
    if ((spots || []).length !== spotIds.length) throw new StaffBookingError('One of the seating spots is not on the current map.');
    const chosenHuts = (spots || []).filter(spot => spot.type === 'hut').length;
    const chosenTables = (spots || []).filter(spot => spot.type === 'table').length;
    if (chosenHuts !== huts || chosenTables !== tables) throw new StaffBookingError(`Choose ${huts} hut${huts === 1 ? '' : 's'} and ${tables} table${tables === 1 ? '' : 's'} (${party ? 'a party includes one hut' : 'as booked'}).`);
  } else if (huts + tables > 0) {
    throw new StaffBookingError(`Choose the seating: ${huts} hut${huts === 1 ? '' : 's'} and ${tables} table${tables === 1 ? '' : 's'}.`);
  }

  const prices = await getCurrentPrices();
  const { lineItems, total } = calculateServerTotal(selections, party, prices);

  // The same item layout as online bookings, so reports, tickets and the daily summary read them alike.
  const items: Array<{ quantity: number; price_per_unit: number; subtotal: number; metadata: Record<string, unknown> }> = [];
  for (const line of lineItems) {
    if (!line.party) {
      items.push({ quantity: line.quantity, price_per_unit: line.pricePerUnit, subtotal: line.subtotal, metadata: { itemId: line.itemId, name: line.name, isPerson: line.isPerson } });
      continue;
    }
    const partyMetadata = { party: true, partySlot: party?.slot, name: line.name, isPerson: line.isPerson };
    items.push({ quantity: line.quantity, price_per_unit: line.pricePerUnit, subtotal: line.subtotal, metadata: partyMetadata });
    if (line.itemId === 'party-children') {
      items.push({ quantity: line.quantity, price_per_unit: 0, subtotal: 0, metadata: { ...partyMetadata, name: 'Birthday party child entrance', isPerson: true } });
    }
  }

  const notes = cleanText(input.notes, 500);
  return { visitDate, customer: { firstName, lastName, email, phone }, party, people, total, items, spotIds, notes };
}

export type StaffBookingResult = { bookingId: string; reference: string; created: boolean; total: number; ticketsEmailed: boolean | null; eftSent: boolean | null };

/**
 * Create a prepared staff booking.
 * - kind IMPORTED: marked paid and imported; tickets are created for check-in but never emailed.
 * - kind OFFICE with payment: marked paid; tickets emailed when there is an email address.
 * - kind OFFICE without payment: left unpaid and the customer is emailed EFT instructions.
 * Re-running with the same idempotency key returns the booking made the first time.
 */
export async function createStaffBooking(prepared: PreparedBooking, options: { kind: 'IMPORTED' | 'OFFICE'; actorId: string; idempotencyKey?: string | null; payment?: { method: OfficePaymentKey; reference?: string } | null }): Promise<StaffBookingResult> {
  const { kind, actorId } = options;
  if (kind === 'OFFICE' && !options.payment && !prepared.customer.email) throw new StaffBookingError('An email address is needed to send EFT payment instructions.');
  const prefix = kind === 'IMPORTED' ? 'IM' : 'BK';
  const reference = `${prefix}-${prepared.visitDate.slice(0, 4)}-${crypto.randomBytes(5).toString('base64url').replace(/[_-]/g, '').slice(0, 8).toUpperCase().padEnd(8, '0')}`;

  const { data: created, error: createError } = await supabase.rpc('create_booking', {
    p_visit_date: prepared.visitDate,
    p_people_count: prepared.people,
    p_customer: prepared.customer,
    p_reference: reference,
    p_total_amount: prepared.total,
    p_party_slot: prepared.party?.slot || null,
    p_idempotency_key: options.idempotencyKey || null,
    p_voucher_code: null,
    p_items: prepared.items,
    p_spot_ids: prepared.spotIds,
  });
  if (createError) throw new StaffBookingError(customerError(createError, 'The booking could not be saved. Check the date, capacity and seating, then try again.'));
  const row = (Array.isArray(created) ? created[0] : created) as { booking_id: string; created: boolean } | null;
  if (!row?.booking_id) throw new Error('Staff booking was not created');
  const { data: booking, error: loadError } = await supabase.from('bookings').select('id,reference,status').eq('id', row.booking_id).single();
  if (loadError) throw loadError;
  if (!row.created) return { bookingId: booking.id, reference: booking.reference, created: false, total: prepared.total, ticketsEmailed: null, eftSent: null };

  const bookingId = booking.id;
  const customerName = `${prepared.customer.firstName} ${prepared.customer.lastName}`.trim();
  let completed = false;
  try {
    if (kind === 'IMPORTED') {
      const { error } = await supabase.from('bookings').update({ status: 'PAID', payment_method: IMPORTED_PAYMENT_METHOD, notes: prepared.notes ? `${IMPORTED_NOTE}
${prepared.notes}` : IMPORTED_NOTE, expires_at: null, sold_by: actorId }).eq('id', bookingId);
      if (error) throw error;
      completed = true;
      // Tickets for check-in at the gate only: never emailed.
      await generateTicketsAndSendEmail(bookingId, prepared.customer.email, customerName, { sendEmail: false });
      await writeAudit(actorId, 'IMPORT_BOOKING', 'booking', bookingId, { reference, visit_date: prepared.visitDate, people: prepared.people, party_slot: prepared.party?.slot || null, seating: prepared.spotIds.length });
      return { bookingId, reference, created: true, total: prepared.total, ticketsEmailed: false, eftSent: null };
    }

    if (options.payment) {
      const method = OFFICE_PAYMENT_METHODS[options.payment.method];
      if (!method) throw new StaffBookingError('Choose how the customer paid.');
      const { error } = await supabase.from('bookings').update({ status: 'PAID', payment_method: method.code, amount_due: prepared.total, expires_at: null, sold_by: actorId, notes: prepared.notes || null }).eq('id', bookingId);
      if (error) throw error;
      const { error: paymentError } = await supabase.from('payments').insert({
        booking_id: bookingId, amount: prepared.total, method: method.code, status: 'COMPLETE', provider_reference: cleanText(options.payment.reference, 80) || `OFFICE-${reference}`,
      });
      if (paymentError) throw paymentError;
      completed = true;
      await writeAudit(actorId, 'OFFICE_BOOKING', 'booking', bookingId, { reference, total: prepared.total, payment_method: method.code, payment_reference: cleanText(options.payment.reference, 80) || null });
      let ticketsEmailed: boolean | null = null;
      if (prepared.customer.email) {
        try {
          await emailTicketsOnce(bookingId, prepared.customer.email, customerName);
          ticketsEmailed = true;
        } catch (emailError) {
          ticketsEmailed = false;
          await recordNotificationFailure('booking', 'TICKETS_EMAIL_FAILED', prepared.customer.email, bookingId, emailError);
        }
      } else {
        await generateTicketsAndSendEmail(bookingId, '', customerName, { sendEmail: false });
      }
      return { bookingId, reference, created: true, total: prepared.total, ticketsEmailed, eftSent: null };
    }

    // Not paid yet: the booking keeps its places until an admin or manager deletes it (staff
    // bookings have no payment window, see STAFF_HOLD_UNTIL), and the customer is emailed the EFT details.
    const { error } = await supabase.from('bookings').update({ payment_method: 'MANUAL_EFT', sold_by: actorId, notes: prepared.notes || null, expires_at: STAFF_HOLD_UNTIL }).eq('id', bookingId);
    if (error) throw error;
    completed = true;
    await writeAudit(actorId, 'OFFICE_BOOKING', 'booking', bookingId, { reference, total: prepared.total, payment: 'EFT instructions sent' });
    let eftSent = true;
    try { await sendEftInstructions(bookingId); } catch (emailError) {
      eftSent = false;
      await recordNotificationFailure('booking', 'EFT_INSTRUCTIONS', prepared.customer.email, bookingId, emailError);
    }
    return { bookingId, reference, created: true, total: prepared.total, ticketsEmailed: null, eftSent };
  } catch (error) {
    // Nothing was recorded as paid yet: remove the half-made booking so it does not hold places or seating.
    if (!completed) {
      const { error: cleanupError } = await supabase.from('bookings').delete().eq('id', bookingId);
      if (cleanupError) console.error('Could not remove incomplete staff booking', bookingId, cleanupError);
    }
    throw error;
  }
}
