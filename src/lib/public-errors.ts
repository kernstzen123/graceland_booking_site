export function customerError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  const safeMessages = [
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
  ];
  if (safeMessages.some(safe => message === safe || message.startsWith(safe))) return message;
  if (/capacity exceeded/i.test(message)) return 'This date is full. Please choose another date or contact support.';
  return fallback;
}
