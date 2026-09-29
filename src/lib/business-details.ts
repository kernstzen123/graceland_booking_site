/**
 * Fixed business details, shared by the booking pages (client) and the emails
 * (server).
 *
 * Bank details deliberately live here in code rather than in the admin panel:
 * changing the account customers pay into needs a code change and a deploy,
 * so a compromised staff login cannot redirect EFT payments.
 *
 * Contact details and daily capacity are editable by admins (Prices & dates →
 * Business details); the values below are only the fallbacks.
 */

export const BANK_DETAILS = {
  bank: 'Nedbank LTD',
  accountName: 'ACE contractors',
  accountNumber: '1039028861',
  branchCode: '103910',
} as const;

export const BUSINESS_NAME = 'Graceland Venues';
/** Legal entity and its CIPC registration number (shown on the website, as ECTA requires). */
export const LEGAL_ENTITY = 'Ace Contractors & Eng CC';
export const REGISTRATION_NUMBER = '1996/026068/23';
export const EMAIL_DOMAIN = 'gracelandvenuespaarl.co.za';
export const DEFAULT_SUPPORT_EMAIL = `support@${EMAIL_DOMAIN}`;
export const DEFAULT_SUPPORT_PHONE = '072 264 4009';
/** Sender for booking emails when EMAIL_FROM_ADDRESS is not set. */
export const DEFAULT_FROM_ADDRESS = `mail@${EMAIL_DOMAIN}`;
export const DEFAULT_DAILY_CAPACITY = 500;
