/**
 * Payments staff record by hand (cash, card or EFT), first added for bookings
 * imported from the booking book and now used on any paid booking, e.g. for
 * the difference after a booking was edited.
 *
 * Imported bookings stay PAID so their seats and capacity are held, but many
 * were unpaid or only partly paid when they were copied in. Staff record each
 * payment as a payments row (status COMPLETE) whose provider_reference starts
 * with IMPORTED_PAYMENT_REFERENCE; the outstanding balance is the booking total
 * less its completed payments. A payment entered by mistake is voided (status
 * VOID), never deleted, so the history stays.
 */

export const IMPORTED_PAYMENT_REFERENCE = 'IMPORTED';
export const VOID_PAYMENT_STATUS = 'VOID';

export const IMPORTED_PAYMENT_METHODS: Record<string, string> = { CASH: 'Cash', CARD: 'Card', EFT: 'EFT' };

/** Largest single payment staff can record (guards against typos such as an extra zero). */
export const MAX_IMPORTED_PAYMENT = 100000;

export class ImportedPaymentError extends Error {}

export type ImportedPaymentInput = { amount: number; method: string; paidOn: string; note: string };

const toDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
};

/** Checks a payment typed in by staff. `today` is the date in South Africa (YYYY-MM-DD). */
export function parseImportedPayment(raw: unknown, today: string): ImportedPaymentInput {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ImportedPaymentError('Enter the amount that was paid.');
  if (Math.round(amount * 100) !== amount * 100) throw new ImportedPaymentError('The amount can have at most 2 decimals.');
  if (amount > MAX_IMPORTED_PAYMENT) throw new ImportedPaymentError(`A single payment cannot be more than R${MAX_IMPORTED_PAYMENT.toLocaleString('en-ZA')}.`);
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  if (!IMPORTED_PAYMENT_METHODS[method]) throw new ImportedPaymentError('Choose how it was paid: cash, card or EFT.');
  const paidOn = typeof input.paidOn === 'string' ? input.paidOn : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || !toDate(paidOn)) throw new ImportedPaymentError('Enter the date it was paid.');
  if (paidOn > today) throw new ImportedPaymentError('The payment date cannot be in the future.');
  if (paidOn < '2020-01-01') throw new ImportedPaymentError('Check the payment date.');
  const note = typeof input.note === 'string' ? input.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
  return { amount, method, paidOn, note };
}

/** provider_reference for a recorded payment: "IMPORTED" or "IMPORTED · deposit". */
export const importedPaymentReference = (note: string) => (note ? `${IMPORTED_PAYMENT_REFERENCE} · ${note}` : IMPORTED_PAYMENT_REFERENCE);

export const isImportedPaymentRow = (payment: { provider_reference?: string | null }) =>
  String(payment.provider_reference || '').startsWith(IMPORTED_PAYMENT_REFERENCE);

/** Noon in South Africa on the day it was paid, so the date reads the same everywhere. */
export const paymentTimestamp = (paidOn: string) => `${paidOn}T12:00:00+02:00`;

export type PaymentState = 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID';

export type PaymentSummary = { total: number; paid: number; outstanding: number; overpaid: number; state: PaymentState };

const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * What has been paid and what is still owed. `total` is what the customer must
 * pay in money (the booking total less any voucher used).
 */
export function paymentSummary(total: number, payments: Array<{ amount: number | string; status: string }>): PaymentSummary {
  const paid = cents(payments.filter(payment => payment.status === 'COMPLETE').reduce((sum, payment) => sum + Number(payment.amount), 0));
  const due = cents(Math.max(0, Number(total) || 0));
  const outstanding = cents(Math.max(0, due - paid));
  const overpaid = cents(Math.max(0, paid - due));
  const state: PaymentState = paid <= 0 && due > 0 ? 'UNPAID' : overpaid > 0 ? 'OVERPAID' : outstanding > 0 ? 'PARTIAL' : 'PAID';
  return { total: due, paid, outstanding, overpaid, state };
}

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  UNPAID: 'Not paid',
  PARTIAL: 'Partly paid',
  PAID: 'Paid in full',
  OVERPAID: 'Overpaid',
};

/**
 * Reads what the booking-book notes say was paid, for the one-off backfill:
 * "no payment" → 0, "paid R1080" / "Paid R550 - …" → 1080 / 550, anything
 * else → null (left for staff to check).
 */
export function paidFromNotes(notes: string | null | undefined): number | null {
  const text = (notes || '').split('\n').filter(line => line.trim() !== 'IMPORTED_FROM_BOOK').join(' ').trim();
  const paid = text.match(/\bpaid\s*R\s?(\d[\d\s,]*(?:\.\d{1,2})?)/i);
  const none = /\bno\s+payment\b/i.test(text);
  if (paid && none) return null;
  if (paid) return Number(paid[1].replace(/[\s,]/g, ''));
  if (none) return 0;
  return null;
}

/**
 * What a voucher refund gives back, as issue_booking_voucher in the database
 * works it out: the completed payments, or, when none are recorded, the total
 * of a booking paid online (an imported booking with none has nothing to refund).
 */
export function voucherRefundAmount(booking: { total_amount: number | string; payment_method?: string | null; payments?: Array<{ amount: number | string; status: string }> | null }) {
  const completed = (booking.payments || []).filter(payment => payment.status === 'COMPLETE');
  if (completed.length) return cents(completed.reduce((sum, payment) => sum + Number(payment.amount), 0));
  return booking.payment_method === 'IMPORTED' ? 0 : cents(Number(booking.total_amount) || 0);
}
