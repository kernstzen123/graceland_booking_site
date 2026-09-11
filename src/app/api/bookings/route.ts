import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { calculatePartyTotal, getPartySlots, PartyDetails } from '@/lib/parties';
import { checkRateLimit, cleanText, isValidEmail } from '@/lib/request-security';
import { customerError } from '@/lib/public-errors';
import { generateTicketsAndSendEmail } from '@/lib/ticketing';
import { recordNotificationFailure } from '@/lib/voucher-email';

const BOOKABLE_ITEMS: Record<string, { name: string; price: number; isPerson: boolean }> = {
  'day-water-infant': { name: 'Children under 1 (including water activities)', price: 0, isPerson: true },
  'day-water-toddler': { name: 'Toddlers 1-2 (including water activities)', price: 110, isPerson: true },
  'day-water-child': { name: 'Children 3-17 (including water activities)', price: 210, isPerson: true },
  'day-water-adult': { name: 'Adult (including water activities)', price: 230, isPerson: true },
  'day-water-pensioner': { name: 'Pensioner (including water activities)', price: 200, isPerson: true },
  'day-no-water-infant': { name: 'Children under 1 (excluding water activities)', price: 0, isPerson: true },
  'day-no-water-toddler': { name: 'Toddlers 1-2 (excluding water activities)', price: 0, isPerson: true },
  'day-no-water-child': { name: 'Children 3-17 (excluding water activities)', price: 100, isPerson: true },
  'day-no-water-adult': { name: 'Adult (excluding water activities)', price: 120, isPerson: true },
  'day-no-water-pensioner': { name: 'Pensioner (excluding water activities)', price: 100, isPerson: true },
  'hut-covered': { name: 'Covered Hut (Seating for 14-16)', price: 400, isPerson: false },
  'hut-shaded': { name: 'Shaded Table (Seating for 6)', price: 250, isPerson: false },
};

export async function POST(request: Request) {
  try {
    if (!(await checkRateLimit(request, 'booking', 10, 60))) return NextResponse.json({ success: false, error: 'Too many booking attempts. Please wait a minute and try again.' }, { status: 429 });
    const body = await request.json();
    const { selectedDate, selections, customerDetails, totalAmount, party, spotIds, idempotencyKey, voucherCode, termsAccepted, privacyAccepted } = body;
    if (!selectedDate || !selections || !customerDetails?.email || Number(totalAmount) < 0) {
      throw new Error('Missing or invalid booking details');
    }
    if (termsAccepted !== true || privacyAccepted !== true) throw new Error('You must accept both the Terms and Conditions and Privacy Policy before booking');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || new Date(`${selectedDate}T00:00:00Z`).toISOString().slice(0, 10) !== selectedDate) throw new Error('Invalid visit date');
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
    const safeCustomerDetails = { firstName, lastName, email, phone };

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

    const partyDetails = party as PartyDetails | undefined;
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
    const maximumHutCount = peopleCount > 24 ? 2 : peopleCount > 8 ? 1 : 0;
    const maximumTableCount = Math.ceil(Math.max(1, peopleCount) / 6);
    if (selectedPaidHutCount > 0 && peopleCount <= 8) throw new Error('Covered huts are available for groups of more than 8 people.');
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

    // 2. Generate a unique booking reference
    const reference = `BK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
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
    const { data: bookingId, error } = await supabase.rpc('reserve_capacity', {
      p_visit_date: selectedDate,
      p_people_count: peopleCount,
      p_customer: safeCustomerDetails,
      p_reference: reference,
      p_total_amount: totalAmount,
      p_party_slot: partyDetails?.enabled ? partyDetails.slot : null,
      p_idempotency_key: requestIdempotencyKey,
      p_voucher_code: typeof voucherCode === 'string' && voucherCode.trim() ? voucherCode.trim().toUpperCase() : null,
    });

    if (error) throw error;
    if (!bookingId) throw new Error('Booking reservation did not return a booking ID');

    const items: Array<{ booking_id: string; quantity: number; price_per_unit: number; subtotal: number; metadata: Record<string, unknown> }> = Object.entries(selections)
      .filter(([, quantity]) => Number(quantity) > 0)
      .map(([itemId, quantity]) => {
        const item = BOOKABLE_ITEMS[itemId];
        if (!item) throw new Error(`Unknown booking item: ${itemId}`);

        return {
          booking_id: bookingId,
          quantity: Number(quantity),
          price_per_unit: item.price,
          subtotal: item.price * Number(quantity),
          // The UI uses stable item IDs. Keep them as metadata until catalog UUIDs
          // are configured in Supabase; ticket generation uses this metadata too.
          metadata: { itemId, name: item.name, isPerson: item.isPerson },
        };
      });

    if (partyDetails?.enabled) {
      const childRate = partyDetails.option === 'option-2' ? 225 : 200;
      const swimmingAdults = partyDetails.adultsWater.filter(Boolean).slice(0, Number(partyDetails.adults)).length;
      const swimmingChildren = partyDetails.additionalChildrenWater.filter(Boolean).slice(0, Number(partyDetails.additionalChildren)).length;
      const adultRate = 80;
      const extraChildRate = 100;
      items.push(
        { booking_id: bookingId, quantity: Number(partyDetails.children), price_per_unit: childRate, subtotal: Number(partyDetails.children) * childRate, metadata: { party: true, partySlot: partyDetails.slot, name: partyDetails.option === 'option-2' ? 'Kiddy Party Option 2 (hotdog included)' : 'Kiddy Party Option 1', isPerson: false } },
        { booking_id: bookingId, quantity: Number(partyDetails.children), price_per_unit: 0, subtotal: 0, metadata: { party: true, partySlot: partyDetails.slot, name: 'Birthday party child entrance', isPerson: true } },
      );
      if (swimmingAdults > 0) items.push({ booking_id: bookingId, quantity: swimmingAdults, price_per_unit: 180, subtotal: swimmingAdults * 180, metadata: { party: true, partySlot: partyDetails.slot, name: 'Birthday party adult entrance (swimming)', isPerson: true } });
      if (Number(partyDetails.adults) - swimmingAdults > 0) items.push({ booking_id: bookingId, quantity: Number(partyDetails.adults) - swimmingAdults, price_per_unit: adultRate, subtotal: (Number(partyDetails.adults) - swimmingAdults) * adultRate, metadata: { party: true, partySlot: partyDetails.slot, name: 'Birthday party adult entrance (non-swimming)', isPerson: true } });
      if (swimmingChildren > 0) items.push({ booking_id: bookingId, quantity: swimmingChildren, price_per_unit: 200, subtotal: swimmingChildren * 200, metadata: { party: true, partySlot: partyDetails.slot, name: 'Additional birthday party child entrance (swimming)', isPerson: true } });
      if (Number(partyDetails.additionalChildren) - swimmingChildren > 0) items.push({ booking_id: bookingId, quantity: Number(partyDetails.additionalChildren) - swimmingChildren, price_per_unit: extraChildRate, subtotal: (Number(partyDetails.additionalChildren) - swimmingChildren) * extraChildRate, metadata: { party: true, partySlot: partyDetails.slot, name: 'Additional birthday party child entrance (non-swimming)', isPerson: true } });
      if (Number(partyDetails.partyPacks) > 0) items.push({ booking_id: bookingId, quantity: Number(partyDetails.partyPacks), price_per_unit: 50, subtotal: Number(partyDetails.partyPacks) * 50, metadata: { party: true, partySlot: partyDetails.slot, name: 'Optional party pack', isPerson: false } });
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
        await recordNotificationFailure('TICKETS_ISSUED_BY_VOUCHER', safeCustomerDetails.email, bookingId, emailError);
      }
    }

    return NextResponse.json({
      success: true,
      reference,
      amountDue: Number(bookingTotals.amount_due ?? totalAmount),
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
