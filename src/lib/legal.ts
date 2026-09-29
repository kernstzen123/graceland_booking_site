/**
 * Versions of the legal documents customers accept when booking. Each booking
 * stores the versions accepted (bookings.terms_version / privacy_version), so
 * change the version whenever the wording of a document changes.
 */

export const TERMS_VERSION = '2026-09-09';
export const PRIVACY_VERSION = '2026-09-29';

/** "2026-09-28" → "28 September 2026". */
export function formatLegalDate(version: string) {
  const [year, month, day] = version.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${day} ${months[month - 1]} ${year}`;
}
