import 'server-only';
import nodemailer from 'nodemailer';
import { supabase } from '@/lib/supabase';
import { BUSINESS_NAME, DEFAULT_FROM_ADDRESS } from '@/lib/business-details';
import { getBusinessSettings } from '@/lib/business-settings';

/**
 * The one place emails are sent from.
 *
 * Production: Resend (RESEND_API_KEY), from EMAIL_FROM_ADDRESS on the verified
 * domain. Development: SMTP when SMTP_HOST/SMTP_USER/SMTP_PASS are set,
 * otherwise Resend, otherwise the email is only logged.
 * Replies go to the support address from the business settings.
 */

export type EmailAttachment = { filename: string; content: Buffer; contentType?: string; contentId?: string };
export type EmailMessage = { to: string; subject: string; html: string; attachments?: EmailAttachment[]; replyTo?: string };

const isProduction = () => process.env.NODE_ENV === 'production';

function resendKey() {
  const key = process.env.RESEND_API_KEY?.trim();
  return key && key !== 'your-resend-api-key' ? key : '';
}

function smtpConfig() {
  const host = process.env.SMTP_HOST; const user = process.env.SMTP_USER; const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return { host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: { user, pass } };
}

function fromAddress(provider: 'resend' | 'smtp') {
  const address = provider === 'smtp'
    ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || DEFAULT_FROM_ADDRESS)
    : (process.env.EMAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS);
  // resend.dev is Resend's test domain and only delivers to the Resend account
  // owner. Allowed until graceland-venues.co.za is verified; then switch
  // EMAIL_FROM_ADDRESS to bookings@graceland-venues.co.za.
  if (isProduction() && /@resend\.dev$/i.test(address)) {
    console.warn('EMAIL_FROM_ADDRESS uses the resend.dev test domain: Resend only delivers these to the account owner. Switch to the verified domain when it is ready.');
  }
  return `${BUSINESS_NAME} <${address}>`;
}

export async function sendEmail(message: EmailMessage) {
  if (!message.to) throw new Error('Recipient email address is missing');
  const replyTo = message.replyTo || (await getBusinessSettings()).supportEmail;
  const smtp = !isProduction() ? smtpConfig() : null;

  if (smtp) {
    await nodemailer.createTransport(smtp).sendMail({
      from: fromAddress('smtp'), to: message.to, replyTo, subject: message.subject, html: message.html,
      attachments: (message.attachments || []).map(file => ({ filename: file.filename, content: file.content, contentType: file.contentType, cid: file.contentId })),
    });
    return;
  }

  const key = resendKey();
  if (!key) {
    if (isProduction()) throw new Error('No email provider is configured: set RESEND_API_KEY.');
    console.warn(`Email not sent (no RESEND_API_KEY or SMTP settings): "${message.subject}" to ${message.to}`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress('resend'),
      to: [message.to],
      reply_to: replyTo,
      subject: message.subject,
      html: message.html,
      attachments: message.attachments?.map(file => ({
        filename: file.filename,
        content: file.content.toString('base64'),
        ...(file.contentType ? { content_type: file.contentType } : {}),
        ...(file.contentId ? { content_id: file.contentId } : {}),
      })),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend rejected the email (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
}

/**
 * Remember an email that could not be sent, so staff can retry it from
 * Settings → Email retries. Never throws.
 */
export async function recordNotificationFailure(entityType: string, type: string, recipient: string, entityId: string, error: unknown) {
  const { error: insertError } = await supabase.from('notification_failures').insert({
    notification_type: type, recipient, entity_type: entityType, entity_id: entityId,
    error_message: (error instanceof Error ? error.message : 'Unknown email error').slice(0, 1000),
  });
  if (insertError) console.error('Could not record notification failure', insertError);
}
