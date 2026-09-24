import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getPartySlots, PartyDetails } from '@/lib/parties';
import { checkRateLimit, cleanText, isValidEmail } from '@/lib/request-security';
import { customerError } from '@/lib/public-errors';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';
import { BOOKABLE_ITEMS, calculateServerTotal, validatePartyFields } from '@/lib/pricing';
import { getCurrentPrices } from '@/lib/price-store';
import { validateBookableDate } from '@/lib/closed-dates';

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'booking', 10, 60))) return NextResponse.json({ success: false, error: 'Too many booking attempts. Please wait a minute and try again.' }, { status: 429 });
    const body = await request.json();
    const { selectedDate, selections, customerDetails, totalAmount, party, spotIds, idempotencyKey, voucherCode, termsAccepted, privacyAccepted, attendeeNames } = body;
    if (!selectedDate || !selections || !customerDetails?.email || Number(totalAmount) < 0) {
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
    if (voucherCode !== undefined && voucherCode !== null && (typeof voucherCode !== 'string' || (voucherCode.trim() && !/^GRC-[A-Z0-9]{8}$/.test(voucherCode.trim().toUpperCase())))) throw new Error('Invalid voucher code');
    if (typeof selections !== 'object' || Array.isArray(selections)) throw new Error('Invalid package selections');
    for (const [key, value] of Object.entries(selections)) {
      if (!/^[a-z0-9-]+$/.test(key) || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 500) throw new Error('Invalid package quantity');
    }
    // Verify every selection key is a known bookable item
    for (const key of Object.keys(selections)) {
      if (Number(selections[key]) > 0 && !BOOKABLE_ITEMS[key]) throw new Error(`Unknown booking item: ${key}`);
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
    const { lineItems, total: serverTotal } = calculateServerTotal(serverSelections, validatedParty, prices);

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
    Object.keys(selections).forEach(key => {
      // Assuming packages with these keywords count towards headcount
      if (key.includes('child') || key.includes('adult') || key.includes('pensioner') || key.includes('infant') || key.includes('toddler')) {
        const quantity = Number(selections[key]);
        peopleCount += quantity;
        selectedPackageCount += quantity;
        if (key.includes('child') || key.includes('toddler') || key.includes('infant')) selectedChildCount += quantity;
        if (key.includes('adult') || key.includes('pensioner')) selectedAdultCount += quantity;
      }
    });

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

    const selectedTableCount = Number(selections['hut-shaded'] || 0);
    const selectedPaidHutCount = Number(selections['hut-covered'] || 0);
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
      const { data: requestedSpots, error: spotError } = await supabase.from('venue_spots').select('id,type,capacity').in('id', requestedSpotIds);
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
    const requestIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.trim() ? idempotencyKey.trim() : null;
    if (requestIdempotencyKey) {
      const { data: existingBooking } = await supabase.from('bookings').select('id,reference').eq('idempotency_key', requestIdempotencyKey).maybeSingle();
      if (existingBooking) {
        if (requestedSpotIds.length > 0) {
          const { error: existingSpotError } = await supabase.rpc('reserve_booking_spots', { p_booking_id: existingBooking.id, p_visit_date: selectedDate, p_spot_ids: requestedSpotIds });
          if (existingSpotError) throw existingSpotError;
        }
        return NextResponse.json({ success: true, reference: existingBooking.reference, message: 'Booking already created.' });
      }
    }

    // Reserve capacity and create the customer/booking in one database transaction.
    // Use the SERVER-COMPUTED total, never the client's totalAmount.
    const { data: bookingId, error } = await supabase.rpc('reserve_capacity', {
      p_visit_date: selectedDate,
      p_people_count: peopleCount,
      p_customer: safeCustomerDetails,
      p_reference: reference,
      p_total_amount: serverTotal,
      p_party_slot: partyDetails?.enabled ? partyDetails.slot : null,
      p_idempotency_key: requestIdempotencyKey,
      p_voucher_code: typeof voucherCode === 'string' && voucherCode.trim() ? voucherCode.trim().toUpperCase() : null,
    });

    if (error) throw error;
    if (!bookingId) throw new Error('Booking reservation did not return a booking ID');

    const items: Array<{ booking_id: string; quantity: number; price_per_unit: number; subtotal: number; metadata: Record<string, unknown> }> = [];
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
          booking_id: bookingId,
          quantity: line.quantity,
          price_per_unit: line.pricePerUnit,
          subtotal: line.subtotal,
          metadata: {
            itemId: line.itemId,
            name: line.name,
            isPerson: line.isPerson,
            ...(attendeeNamesForItem.length > 0 ? { attendeeNames: attendeeNamesForItem } : {}),
          },
        });
        continue;
      }
      const partyMetadata = { party: true, partySlot: partyDetails?.slot, name: line.name, isPerson: line.isPerson };
      items.push({ booking_id: bookingId, quantity: line.quantity, price_per_unit: line.pricePerUnit, subtotal: line.subtotal, metadata: partyMetadata });
      // The party package is priced per child; each party child also gets a free entrance ticket.
      if (line.itemId === 'party-children') {
        items.push({ booking_id: bookingId, quantity: line.quantity, price_per_unit: 0, subtotal: 0, metadata: { ...partyMetadata, name: 'Birthday party child entrance', isPerson: true } });
      }
    }

    if (!items.length) throw new Error('At least one booking item is required');

    const { error: itemsError } = await supabase.from('booking_items').insert(items);
    if (itemsError) throw itemsError;

    if (requestedSpotIds.length > 0) {
      const { error: spotReservationError } = await supabase.rpc('reserve_booking_spots', { p_booking_id: bookingId, p_visit_date: selectedDate, p_spot_ids: requestedSpotIds });
      if (spotReservationError) throw spotReservationError;
    }

    const { data: bookingTotals, error: totalsError } = await supabase.from('bookings').select('amount_due,voucher_amount_used,voucher_credit_id,status').eq('id', bookingId).single();
    if (totalsError) throw totalsError;
    let voucherRemainingBalance = 0;
    if (bookingTotals.voucher_credit_id) {
      const { data: voucherCredit, error: voucherError } = await supabase.from('booking_credits').select('remaining_balance').eq('id', bookingTotals.voucher_credit_id).maybeSingle();
      if (voucherError) throw voucherError;
      voucherRemainingBalance = Number(voucherCredit?.remaining_balance || 0);
    }
    if (bookingTotals.status === 'PAID' && Number(bookingTotals.amount_due || 0) === 0) {
      await supabase.from('bookings').update({ payment_method: 'VOUCHER', notes: 'PAID_BY_VOUCHER' }).eq('id', bookingId);
      const { error: paymentError } = await supabase.from('payments').insert({ booking_id: bookingId, amount: 0, method: 'VOUCHER', status: 'COMPLETE', provider_reference: `VOUCHER-${bookingId}` });
      if (paymentError) throw paymentError;
      try {
        await generateTicketsAndSendEmail(bookingId, safeCustomerDetails.email, `${safeCustomerDetails.firstName} ${safeCustomerDetails.lastName}`);
      } catch (emailError) {
        await recordNotificationFailure('booking', 'TICKETS_ISSUED_BY_VOUCHER', safeCustomerDetails.email, bookingId, emailError);
      }
    }

    return NextResponse.json({
      success: true,
      reference,
      amountDue: Number(bookingTotals.amount_due ?? serverTotal),
      voucherAmountUsed: Number(bookingTotals.voucher_amount_used || 0),
      voucherRemainingBalance,
      paymentRequired: !(bookingTotals.status === 'PAID' && Number(bookingTotals.amount_due || 0) === 0),
      message: "Capacity reserved. Booking pending payment."
    });

  } catch (error: unknown) {
    console.error('Booking request failed', error);
    return NextResponse.json({
      success: false,
      error: customerError(error, 'We could not create your booking. Please try again or contact support.')
    }, { status: 500 });
  }
}
