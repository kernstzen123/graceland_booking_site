import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildBookingCard, checkInBlocker, type BookingCardRow } from '@/lib/booking-card';
import { classifyScan, createScanBuffer, SCAN_KEY_GAP_MS } from '@/lib/handheld-scanner';
import { createBookingQrToken, createQrToken, verifyQrToken } from '@/lib/qr-token';
import { bookingEmailBody, bookingSummaryLines, createBookingPdf } from '@/lib/booking-email';

const familyRow = (changes: Partial<BookingCardRow> = {}): BookingCardRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  reference: 'BK-2026-ABCD1234',
  status: 'PAID',
  visit_date: '2026-12-05',
  party_slot: null,
  total_amount: 1270,
  amount_due: 1270,
  voucher_amount_used: 0,
  payment_method: 'PAYFAST',
  notes: 'Wheelchair access',
  expires_at: null,
  deleted_at: null,
  voucher_issued: false,
  customers: { first_name: 'Thandi', last_name: 'Mokoena', phone: '0820000000' },
  booking_items: [
    { quantity: 2, metadata: { itemId: 'day-water-adult', name: 'Adult (swimming)', isPerson: true, attendeeNames: [{ firstName: 'Thandi', lastName: 'Mokoena' }, { firstName: 'Sipho', lastName: 'Mokoena' }] } },
    { quantity: 3, metadata: { itemId: 'day-water-child', name: 'Child (swimming)', isPerson: true } },
    { quantity: 1, metadata: { itemId: 'hut-covered', name: 'Covered Hut' } },
    { quantity: 1, metadata: { itemId: 'upgrade-swimming', name: 'Upgrade to swimming' } },
  ],
  booking_spots: [{ venue_spots: { number: 'T2', type: 'table' } }, { venue_spots: { number: 'H4', type: 'hut' } }],
  payments: [{ amount: 1270, status: 'COMPLETE' }],
  tickets: [{ ticket_uid: 'TKT-1', status: 'USED' }, { ticket_uid: 'TKT-2', status: 'VALID' }, { ticket_uid: 'TKT-3', status: 'VALID' }, { ticket_uid: 'TKT-4', status: 'VALID' }, { ticket_uid: 'TKT-5', status: 'VALID' }, { ticket_uid: 'TKT-6', status: 'CANCELLED' }],
  meal_vouchers: [{ status: 'VALID' }],
  ...changes,
});

describe('booking card (what the gate scanner shows)', () => {
  it('lists the passes, hut and table, names, total, payment and check-ins', () => {
    const card = buildBookingCard(familyRow(), Date.parse('2026-12-05T08:00:00Z'));
    expect(card).toMatchObject({
      customerName: 'Thandi Mokoena', reference: 'BK-2026-ABCD1234', partySlot: null, active: true,
      passes: [{ name: 'Adult (swimming)', quantity: 2 }, { name: 'Child (swimming)', quantity: 3 }, { name: 'Upgrade to swimming', quantity: 1 }],
      seating: ['Hut 4', 'Table 2'], names: ['Thandi Mokoena', 'Sipho Mokoena'],
      total: 1270, paid: 1270, owing: 0, unpaid: false, notes: 'Wheelchair access', meals: 1,
      people: 5, checkedIn: 1,
    });
  });

  it('shows an unpaid booking with what is still owed', () => {
    const card = buildBookingCard(familyRow({ status: 'UNPAID', expires_at: '9999-12-31T23:59:59Z', payments: [{ amount: 300, status: 'COMPLETE' }] }));
    expect(card).toMatchObject({ active: true, unpaid: true, paid: 300, owing: 970 });
  });

  it('counts a party by its children and adults, not its free entrance lines twice', () => {
    const card = buildBookingCard(familyRow({
      party_slot: '14:30–16:30', booking_spots: [], tickets: [],
      booking_items: [
        { quantity: 10, metadata: { name: 'Kiddy Party Option 1', party: true } },
        { quantity: 10, metadata: { name: 'Birthday party child entrance', party: true, isPerson: true } },
        { quantity: 2, metadata: { name: 'Birthday party adult entrance (swimming)', party: true, isPerson: true } },
      ],
    }));
    expect(card.passes).toEqual([{ name: 'Kiddy Party Option 1', quantity: 10 }, { name: 'Birthday party adult entrance (swimming)', quantity: 2 }]);
    expect(card.people).toBe(12);
    expect(card.seating).toEqual([]);
  });

  it('says why a booking cannot be checked in', () => {
    const today = '2026-12-05';
    expect(checkInBlocker(buildBookingCard(familyRow()), today)).toBeNull();
    expect(checkInBlocker(buildBookingCard(familyRow()), '2026-12-06')).toMatch(/not today/);
    expect(checkInBlocker(buildBookingCard(familyRow({ deleted_at: '2026-12-01T00:00:00Z' })), today)).toMatch(/cancelled/);
    expect(checkInBlocker(buildBookingCard(familyRow({ status: 'UNPAID', expires_at: '2020-01-01T00:00:00Z' })), today)).toMatch(/not paid in time/);
    const allIn = familyRow({ tickets: [{ ticket_uid: 'TKT-1', status: 'USED' }, { ticket_uid: 'TKT-2', status: 'USED' }] });
    expect(checkInBlocker(buildBookingCard(allIn), today)).toMatch(/already checked in/);
  });
});

describe('handheld scanner input', () => {
  const type = (buffer: ReturnType<typeof createScanBuffer>, text: string, start: number, gap = 5) => {
    let at = start;
    let result: string | null = null;
    for (const key of [...text, 'Enter']) { result = buffer.key(key, at); at += gap; }
    return result;
  };

  it('turns fast key presses ending in Enter into one scan', () => {
    const buffer = createScanBuffer();
    expect(type(buffer, 'https://example.com/admin/scanner?token=abc.def', 1000)).toBe('https://example.com/admin/scanner?token=abc.def');
    expect(type(buffer, 'TKT-1A2B3C4D', 5000)).toBe('TKT-1A2B3C4D');
  });

  it('ignores slow typing, short bursts and modifier keys', () => {
    const buffer = createScanBuffer();
    expect(type(buffer, 'TKT-1A2B3C4D', 1000, SCAN_KEY_GAP_MS + 50)).toBeNull();
    expect(type(buffer, 'abc', 9000)).toBeNull();
    expect(buffer.key('Shift', 10000)).toBeNull();
    expect(type(buffer, 'BK-2026-XY', 11000)).toBe('BK-2026-XY');
  });

  it('knows while a scan is being typed (so Enter does not press a button)', () => {
    const buffer = createScanBuffer();
    buffer.key('T', 100);
    expect(buffer.active(110)).toBe(true);
    expect(buffer.active(100 + SCAN_KEY_GAP_MS + 1)).toBe(false);
  });

  it('tells booking and ticket codes, meal vouchers and garbled scans apart', () => {
    const booking = createBookingQrToken('11111111-1111-4111-8111-111111111111', 'BK-2026-ABCD1234', '2026-12-05');
    const meal = createQrToken('11111111-1111-4111-8111-111111111111', 'MEAL-AB12', '2026-12-05', 'meal');
    expect(classifyScan(`https://www.example.co.za/admin/scanner?token=${encodeURIComponent(booking)}`)).toBe('code');
    expect(classifyScan(booking)).toBe('code');
    expect(classifyScan('TKT-1A2B3C4D')).toBe('code');
    expect(classifyScan('BK-2026-ABCD1234')).toBe('code');
    expect(classifyScan(meal)).toBe('meal');
    expect(classifyScan('MEAL-AB12')).toBe('meal');
    // What a scanner set to another keyboard layout typically sends.
    expect(classifyScan('https;//www.example.co.za/admin/scanner_token=abc')).toBe('garbled');
    expect(classifyScan('hello there')).toBe('garbled');
  });
});

describe('booking QR codes', () => {
  it('are signed for the booking and keep working after the visit date moves', () => {
    const token = createBookingQrToken('11111111-1111-4111-8111-111111111111', 'BK-2026-ABCD1234', '2020-01-01');
    expect(verifyQrToken(token)).toMatchObject({ type: 'booking', bid: '11111111-1111-4111-8111-111111111111', tid: 'BK-2026-ABCD1234' });
    // Ticket codes still stop working after their date.
    expect(verifyQrToken(createQrToken('11111111-1111-4111-8111-111111111111', 'TKT-1', '2020-01-01'))).toBeNull();
  });

  it('cannot be changed without breaking the signature', () => {
    const token = createBookingQrToken('11111111-1111-4111-8111-111111111111', 'BK-2026-ABCD1234', '2026-12-05');
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(Buffer.from(payload, 'base64url').toString().replace('BK-2026-ABCD1234', 'BK-2026-OTHER000')).toString('base64url');
    expect(verifyQrToken(`${forged}.${signature}`)).toBeNull();
  });
});

describe('booking email and PDF', () => {
  it('shows one QR code with the booking summary', () => {
    const card = buildBookingCard(familyRow());
    const html = bookingEmailBody({ card, customerName: 'Thandi Mokoena', qrContentId: 'booking-qr' });
    expect(html).toContain('cid:booking-qr');
    expect(html).toContain('Show this one QR code at the entrance for your whole group (5 people)');
    expect(html).toContain('2 × Adult (swimming)');
    expect(html).toContain('Hut 4, Table 2');
    expect(html).toContain('BOOKING CONFIRMED');
    expect(html.match(/cid:/g)).toHaveLength(1);
  });

  it('says an unpaid booking is not paid and what is owed', () => {
    const card = buildBookingCard(familyRow({ status: 'UNPAID', expires_at: '9999-12-31T23:59:59Z', payments: [] }));
    const html = bookingEmailBody({ card, customerName: 'Thandi', qrContentId: 'booking-qr' });
    expect(html).toContain('NOT PAID');
    expect(bookingSummaryLines(card).payment).toBe('NOT PAID: R 1270.00 still owed');
  });

  it('makes a one-page PDF', async () => {
    const QRCode = (await import('qrcode')).default;
    const png = await QRCode.toBuffer('https://example.com/admin/scanner?token=x.y', { type: 'png', width: 320 });
    const { filename, content } = await createBookingPdf(buildBookingCard(familyRow()), png);
    expect(filename).toBe('BK-2026-ABCD1234.pdf');
    expect((await PDFDocument.load(content)).getPageCount()).toBe(1);
  });
});
