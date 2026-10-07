import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getPartySlots, PartyDetails } from '@/lib/parties';
import { checkRateLimit, cleanText, isRateLimited, isValidEmail, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_WINDOW } from '@/lib/request-security';
import { customerError, customerErrorStatus } from '@/lib/public-errors';
import { emailTicketsOnce } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/mailer';
import { isVoucherCode, normalizeVoucherCode } from '@/lib/voucher-code';
import { PRIVACY_VERSION, TERMS_VERSION } from '@/lib/legal';
import { BOOKABLE_ITEMS, calculateServerTotal, validatePartyFields } from '@/lib/pricing';
import { getCurrentPrices } from '@/lib/price-store';
import { validateBookableDate } from '@/lib/closed-dates';
import { loadBookingSpecials, SpecialSelectionError } from '@/lib/specials-server';

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'booking', 10, 60))) return NextResponse.json({ success: false, error: 'Too many booking attempts. Please wait a minute and try again.' }, { status: 429 });
    const body = await request.json();
    const { selectedDate, selections, customerDetails, totalAmount, party, spotIds, idempotencyKey, voucherCode, termsAccepted, privacyAccepted, attendeeNames, specials: requestedSpecials } = body;
    if (!selectedDate || (!selections && !(Array.isArray(requestedSpecials) && requestedSpecials.length)) || !customerDetails?.email || Number(totalAmount) < 0) {
      throw new Error('Missing or invalid booking details');
    }
    if (termsAccepted !== true || privacyAccepted !== true) throw new Error('You must accept both the Terms and Conditions and Privacy Policy before booking');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || new Date(`${selectedDate}T00:00:00Z`).toISOString().slice(0, 10) !== selectedDate) throw new Error('Invalid visit date');
    await validateBookableDate(selectedDate);
    const firstName = cleanText(customerDetails.firstName, 80);
    const lastName = cleanText(customerDetails.lastName, 80);
    const email = cleanText(customerDetails.email, 254).toLowerCase();
    const phone = cleanText(customerDetails.phone, 40);
    if (firstName.length < 1 || lastName.length < 1 || !isValidEmail(email) || phone.length < 5) throw new Error('Please provide valid customer details');
    if (!Number.isFinite(Number(totalAmount)) || Number(totalAmount) > 1000000) throw new Error('Invalid booking amount');
    const normalizedVoucher = typeof voucherCode === 'string' && voucherCode.trim() ? normalizeVoucherCode(voucherCode) : '';
    if (voucherCode !== undefined && voucherCode !== null && (typeof voucherCode !== 'string' || (voucherCode.trim() && !isVoucherCode(normalizedVoucher)))) throw new Error('Invalid voucher code');
    if (normalizedVoucher && await isRateLimited(request, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_WINDOW)) {
      return NextResponse.json({ success: false, error: 'Too many incorrect voucher codes. Please try again in an hour or contact us.' }, { status: 429 });
    }
    if (typeof selections !== 'object' || Array.isArray(selections)) throw new Error('Invalid package selections');
    for (const [key, value] of Object.entries(selections)) {
      if (!/^[a-z0-9-]+$/.test(key) || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 500) throw new Error('Invalid package quantity');
    }
    // Verify every selection key is a known bookable item
    for (const key of Object.keys(selections || {})) {
      if (Number(selections[key]) > 0 && !BOOKABLE_ITEMS[key]) throw new Error(`Unknown booking item: ${key}`);
    }
    // Only each special's id and quantity are taken from the request: its price,
    // tickets and meals are loaded from the database, never from the browser.
    let specials;
    try {
      specials = await loadBookingSpecials(requestedSpecials, selectedDate);
    } catch (specialError) {
      if (specialError instanceof SpecialSelectionError) return NextResponse.json({ success: false, error: specialError.message }, { status: 400 });
      throw specialError;
    }
    const safeCustomerDetails = { firstName, lastName, email, phone };

    // Validate and sanitize party details
    const isParty = (party as PartyDetails | undefined)?.enabled === true;
    let validatedParty: PartyDetails | undefined;
    if (isParty) {
      validatedParty = validatePartyFields(party as PartyDetails);
    }

    // Validate and sanitize attendee names (only for non-party bookings)
    let sanitizedAttendeeNames: Array<{ firstName: string; lastName: string }> = [];
    if (!isParty && Array.isArray(attendeeNames) && attendeeNames.length > 0) {
      sanitizedAttendeeNames = attendeeNames.map((entry: { firstName?: string; lastName?: string }) => {
        const aFirst = cleanText(String(entry?.firstName || ''), 80);
        const aLast = cleanText(String(entry?.lastName || ''), 80);
        if (aFirst.length < 1 || aLast.length < 1) throw new Error('Each attendee must have a first name and surname');
        return { firstName: aFirst, lastName: aLast };
      });
    }

    // --- SERVER-SIDE PRICING (never trust client totalAmount for money) ---
    const serverSelections: Record<string, number> = {};
    for (const [key, value] of Object.entries(selections)) {
      const qty = Number(value);
      if (qty > 0) serverSelections[key] = qty;
    }
    const prices = await getCurrentPrices();
    const { lineItems, total: serverTotal } = calculateServerTotal(serverSelections, validatedParty, prices, specials);

    // Reject if the server total is zero or negative
    if (serverTotal <= 0) throw new Error('Invalid booking amount');

    // Compare server total against client total (tolerance R0.01)
    const clientTotal = Number(totalAmount);
    if (Math.abs(serverTotal - clientTotal) > 0.01) {
      console.error(`Price mismatch: server=${serverTotal}, client=${clientTotal}, selections=${JSON.stringify(serverSelections)}, party=${JSON.stringify(validatedParty)}`);
      throw new Error('Prices have been updated. Please refresh the page and try again.');
    }

    // 1. Calculate the total people count from selections
    let peopleCount = 0;
    let selectedPackageCount = 0;
    let selectedChildCount = 0;
    let selectedAdultCount = 0;
    Object.keys(selections || {}).forEach(key => {
      // Assuming packages with these keywords count towards headcount
      if (key.includes('child') || key.includes('adult') || key.includes('pensioner') || key.includes('infant') || key.includes('toddler')) {
        const quantity = Number(selections[key]);
        peopleCount += quantity;
        selectedPackageCount += quantity;
        if (key.includes('child') || key.includes('toddler') || key.includes('infant')) selectedChildCount += quantity;
        if (key.includes('adult') || key.includes('pensioner')) selectedAdultCount += quantity;
      }
    });

    for (const special of specials) {
      const tickets = [...(special.snapshot.paid_tickets || []), ...(special.snapshot.free_tickets || [])];
      for (const t of tickets) {
        const quantity = Number(t.quantity) * Number(special.quantity);
        if (t.itemId.includes('child') || t.itemId.includes('adult') || t.itemId.includes('pensioner') || t.itemId.includes('infant') || t.itemId.includes('toddler')) {
          peopleCount += quantity;
          selectedPackageCount += quantity;
          if (t.itemId.includes('child') || t.itemId.includes('toddler') || t.itemId.includes('infant')) selectedChildCount += quantity;
          if (t.itemId.includes('adult') || t.itemId.includes('pensioner')) selectedAdultCount += quantity;
        }
      }
    }

    const partyDetails = validatedParty;
    if (partyDetails?.enabled) {
      if (!['option-1', 'option-2'].includes(partyDetails.option) || Number(partyDetails.children) < 10) {
        throw new Error('Birthday parties require at least 10 children and a valid party option');
      }
      if (!getPartySlots(selectedDate).some(slot => slot === partyDetails.slot)) throw new Error('Birthday parties are not available on this date or time slot');
      peopleCount += Number(partyDetails.children) + Number(partyDetails.adults) + Number(partyDetails.additionalChildren);
      selectedChildCount += Number(partyDetails.children) + Number(partyDetails.additionalChildren);
      selectedAdultCount += Number(partyDetails.adults);
      selectedPackageCount += 1;
    }
    if (selectedPackageCount === 0) throw new Error('Please select at least one entrance package before continuing.');
    if (selectedChildCount > 0 && selectedAdultCount === 0) throw new Error('A child pass must be booked with at least one adult or pensioner entrance.');

    const selectedTableCount = Number((selections && selections['hut-shaded']) || 0);
    const selectedPaidHutCount = Number((selections && selections['hut-covered']) || 0);
    const requiredHutCount = selectedPaidHutCount + (partyDetails?.enabled ? 1 : 0);
    const maximumHutCount = peopleCount >= 12 ? 2 : peopleCount >= 6 ? 1 : 0;
    const maximumTableCount = Math.max(1, Math.ceil(peopleCount / 6));
    if (requiredHutCount > 0 && peopleCount < 6) throw new Error('Covered huts require a minimum of 6 people.');
    if (requiredHutCount > 1 && peopleCount < 12) throw new Error('Booking 2 huts requires a minimum of 12 people.');
    if (requiredHutCount > maximumHutCount) throw new Error(`This group can select a maximum of ${maximumHutCount} hut${maximumHutCount === 1 ? '' : 's'}.`);
    if (selectedTableCount > maximumTableCount) throw new Error(`This group can select a maximum of ${maximumTableCount} table${maximumTableCount === 1 ? '' : 's'}.`);
    const requestedSpotIds = Array.isArray(spotIds) ? spotIds.filter(value => typeof value === 'string') : [];
    const seatingRequired = selectedTableCount > 0 || requiredHutCount > 0;
    if (seatingRequired && requestedSpotIds.length === 0) throw new Error('Please select your seating spot before continuing.');
    if (!seatingRequired && requestedSpotIds.length > 0) throw new Error('Seating was selected for a booking that does not require a seating spot.');
    if (requestedSpotIds.length > 0) {
      const { data: requestedSpots, error: spotError } = await supabase.from('venue_spots').select('id,type,capacity').in('id', requestedSpotIds).eq('active', true);
      if (spotError) throw spotError;
      if (!requestedSpots || requestedSpots.length !== requestedSpotIds.length) throw new Error('One of the selected seating spots is invalid.');
      const tableSpots = requestedSpots.filter(spot => spot.type === 'table');
      const hutSpots = requestedSpots.filter(spot => spot.type === 'hut');
      if (tableSpots.length !== selectedTableCount || hutSpots.length !== requiredHutCount) throw new Error('Please select the correct number and type of seating spots.');
    }

    // 2. Generate a unique booking reference using crypto for sufficient entropy.
    // 8 alphanumeric characters ≈ 41 bits of entropy vs the old 6-digit (~20 bit) format.
    const refChars = crypto.randomBytes(5).toString('base64url').replace(/[_-]/g, '').slice(0, 8).toUpperCase().padEnd(8, '0');
    const reference = `BK-${new Date().getFullYear()}-${refChars}`;
    const requestIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim().slice(0, 100) : null;

    const items: Array<{ quantity: number; price_per_unit: number; subtotal: number; metadata: Record<string, unknown> }> = [];
    let attendeeIdx = 0;
    for (const line of lineItems) {
      if (!line.party) {
        // Attach attendee names to each individual unit of person-type items
        const attendeeNamesForItem: Array<{ firstName: string; lastName: string }> = [];
        if (line.isPerson && sanitizedAttendeeNames.length > 0) {
          for (let i = 0; i < line.quantity; i++) {
            if (attendeeIdx < sanitizedAttendeeNames.length) {
              attendeeNamesForItem.push(sanitizedAttendeeNames[attendeeIdx]);
              attendeeIdx++;
            }
          }
        }
        items.push({
          quantity: line.quantity,
          price_per_unit: line.pricePerUnit,
          subtotal: line.subtotal,
          metadata: {
            itemId: line.itemId,
            name: line.name,
            isPerson: line.isPerson,
            // Lines from a special carry it, so reports can attribute revenue, free tickets and discounts.
            ...(line.specialId ? { specialId: line.specialId, specialRole: line.specialRole, ...(line.fullPricePerUnit !== undefined ? { fullPricePerUnit: line.fullPricePerUnit } : {}) } : {}),
            ...(attendeeNamesForItem.length > 0 ? { attendeeNames: attendeeNamesForItem } : {}),
          },
        });
        continue;
      }
      const partyMetadata = { party: true, partySlot: partyDetails?.slot, name: line.name, isPerson: line.isPerson };
      items.push({ quantity: line.quantity, price_per_unit: line.pricePerUnit, subtotal: line.subtotal, metadata: partyMetadata });
      // The party package is priced per child; each party child also gets a free entrance ticket.
      if (line.itemId === 'party-children') {
        items.push({ quantity: line.quantity, price_per_unit: 0, subtotal: 0, metadata: { ...partyMetadata, name: 'Birthday party child entrance', isPerson: true } });
      }
    }
    if (!items.length) throw new Error('At least one booking item is required');

    // Capacity, voucher, customer, booking, items and seating are saved in ONE
    // database transaction: if any part fails (e.g. the hut was just taken),
    // nothing is saved and no places are held. Uses the SERVER-COMPUTED total.
    // The versions of the terms and privacy policy accepted are stored with it.
    const { data: created, error } = await supabase.rpc('create_booking', {
      p_visit_date: selectedDate,
      p_people_count: peopleCount,
      p_customer: safeCustomerDetails,
      p_reference: reference,
      p_total_amount: serverTotal,
      p_party_slot: partyDetails?.enabled ? partyDetails.slot : null,
      p_idempotency_key: requestIdempotencyKey,
      p_voucher_code: normalizedVoucher || null,
      p_items: items,
      p_spot_ids: requestedSpotIds,
      p_terms_version: TERMS_VERSION,
      p_privacy_version: PRIVACY_VERSION,
      p_specials: specials,
    });
    if (error) {
      // Count wrong voucher codes towards the guessing lockout.
      if (normalizedVoucher && /voucher code is invalid/i.test(error.message)) await checkRateLimit(request, VOUCHER_FAILURE_SCOPE, VOUCHER_FAILURE_LIMIT, VOUCHER_FAILURE_WINDOW);
      throw error;
    }
    const row = (Array.isArray(created) ? created[0] : created) as { booking_id: string; created: boolean } | null;
    if (!row?.booking_id) throw new Error('Booking reservation did not return a booking ID');
    const bookingId = row.booking_id;

    const { data: bookingTotals, error: totalsError } = await supabase.from('bookings').select('reference,visit_date,total_amount,created_at,amount_due,voucher_amount_used,voucher_credit_id,status').eq('id', bookingId).single();
    if (totalsError) throw totalsError;
    // A reused key only means "the same booking again" for a retry of the same
    // request moments later. If it matches an older or different booking (e.g.
    // the browser kept the key after an earlier booking), refuse, so the
    // customer never gets someone else's or an old booking back; the booking
    // page then retries with a fresh key.
    if (!row.created) {
      const sameRequest = String(bookingTotals.visit_date) === selectedDate
        && Math.abs(Number(bookingTotals.total_amount) - serverTotal) < 0.01
        && Date.now() - new Date(bookingTotals.created_at).getTime() < 30 * 60 * 1000
        && !['CANCELLED', 'REFUNDED'].includes(bookingTotals.status);
      if (!sameRequest) {
        return NextResponse.json({ success: false, code: 'STALE_BOOKING_KEY', error: 'This booking form was already used. Please refresh the page and try again.' }, { status: 409 });
      }
    }
    let voucherRemainingBalance = 0;
    if (bookingTotals.voucher_credit_id) {
      const { data: voucherCredit, error: voucherError } = await supabase.from('booking_credits').select('remaining_balance').eq('id', bookingTotals.voucher_credit_id).maybeSingle();
      if (voucherError) throw voucherError;
      voucherRemainingBalance = Number(voucherCredit?.remaining_balance || 0);
    }
    const paidByVoucher = bookingTotals.status === 'PAID' && Number(bookingTotals.amount_due || 0) === 0;
    if (paidByVoucher) {
      const voucherPaymentReference = `VOUCHER-${bookingId}`;
      const { data: voucherPayment } = await supabase.from('payments').select('id').eq('provider_reference', voucherPaymentReference).maybeSingle();
      if (!voucherPayment) {
        await supabase.from('bookings').update({ payment_method: 'VOUCHER', notes: 'PAID_BY_VOUCHER' }).eq('id', bookingId);
        const { error: paymentError } = await supabase.from('payments').insert({ booking_id: bookingId, amount: 0, method: 'VOUCHER', status: 'COMPLETE', provider_reference: voucherPaymentReference });
        if (paymentError) throw paymentError;
      }
      try {
        await emailTicketsOnce(bookingId, safeCustomerDetails.email, `${safeCustomerDetails.firstName} ${safeCustomerDetails.lastName}`);
      } catch (emailError) {
        await recordNotificationFailure('booking', 'TICKETS_ISSUED_BY_VOUCHER', safeCustomerDetails.email, bookingId, emailError);
      }
    }

    return NextResponse.json({
      success: true,
      reference: bookingTotals.reference || reference,
      amountDue: Number(bookingTotals.amount_due ?? serverTotal),
      voucherAmountUsed: Number(bookingTotals.voucher_amount_used || 0),
      voucherRemainingBalance,
      paymentRequired: !paidByVoucher,
      message: row.created ? 'Capacity reserved. Booking pending payment.' : 'Booking already created.',
    });

  } catch (error: unknown) {
    const status = customerErrorStatus(error);
    if (status === 500) console.error('Booking request failed', error);
    return NextResponse.json({
      success: false,
      error: customerError(error, 'We could not create your booking. Please try again or contact support.')
    }, { status });
  }
}