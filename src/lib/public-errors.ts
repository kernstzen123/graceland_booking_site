/**
 * Errors thrown while handling a customer request whose message is safe to
 * show them. Anything else becomes a generic message (and a 500), so internal
 * details never reach the browser.
 */
const SAFE_MESSAGES = [
  'Missing or invalid booking details', 'Invalid visit date', 'Please provide valid customer details',
  'Invalid booking amount', 'Invalid package selections', 'Invalid package quantity',
  'You must accept both the Terms and Conditions and Privacy Policy before booking',
  'Please select at least one entrance package before continuing.',
  'Please select at least one package before continuing.',
  'A child pass must be booked with at least one adult or pensioner entrance.',
  'Birthday parties require at least 10 children and a valid party option',
  'Birthday parties are not available on this date or time slot',
  'That birthday party time slot has already been booked.', 'Booking not found',
  'This booking is already paid', 'File must be 10 MB or smaller',
  'Only PDF, JPG, and PNG files are allowed', 'The uploaded file is not a valid PDF, JPG, or PNG',
  'Prices have been updated. Please refresh the page and try again.',
  'Invalid party field:',
  'Unknown booking item:',
  'Too many requests. Please wait a moment and try again.',
  'Booking reference is required',
  'Graceland is closed on the selected date. Please choose another date.',
  'The selected visit date has already passed. Please choose a future date.',
  'Invalid voucher code', 'That voucher code is invalid or has no remaining balance',
  'This voucher has expired.', 'This voucher can only be used for visits up to',
  'Bookings are open until',
  'Each attendee must have a first name and surname',
  'Covered huts require a minimum of 6 people.', 'Booking 2 huts requires a minimum of 12 people.',
  'This group can select a maximum of',
  'Please select your seating spot before continuing.',
  'Seating was selected for a booking that does not require a seating spot.',
  'One of the selected seating spots is invalid.',
  'Please select the correct number and type of seating spots.',
  'This seating spot was just taken. Please choose another spot.',
  'A seating spot was selected more than once',
  'At least one booking item is required',
];

/** Messages that mean "someone else got there first" rather than bad input. */
const CONFLICT_MESSAGES = [
  'That birthday party time slot has already been booked.',
  'This seating spot was just taken. Please choose another spot.',
  'This booking is already paid',
];

const messageOf = (error: unknown) => error instanceof Error ? error.message : String((error as { message?: unknown })?.message || '');
const isSafe = (message: string) => SAFE_MESSAGES.some(safe => message === safe || message.startsWith(safe));

export function customerError(error: unknown, fallback: string) {
  const message = messageOf(error);
  if (isSafe(message)) return message;
  if (/capacity exceeded/i.test(message)) return 'This date is full. Please choose another date or contact support.';
  return fallback;
}

/** HTTP status for a customer request error: 400 bad input, 409 conflict, 500 our fault. */
export function customerErrorStatus(error: unknown) {
  const message = messageOf(error);
  if (/capacity exceeded/i.test(message) || CONFLICT_MESSAGES.some(conflict => message.startsWith(conflict))) return 409;
  return isSafe(message) ? 400 : 500;
}
