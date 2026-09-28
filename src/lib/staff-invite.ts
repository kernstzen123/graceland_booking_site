import 'server-only';
import { supabase } from '@/lib/supabase';
import { escapeHtml } from '@/lib/email-layout';
import { sendEmail } from '@/lib/mailer';

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export class StaffInviteError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * Email a staff member a fresh link to activate their account (never signed in)
 * or set a new password (existing account). Used by the Staff page and by
 * Email retries.
 */
export async function sendStaffSetupLink(userId: string) {
  const { data: staff } = await supabase.from('admin_roles').select('id,display_name').eq('id', userId).maybeSingle();
  if (!staff) throw new StaffInviteError('Staff member not found', 404);
  const { data: authUser, error: authUserError } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email;
  if (authUserError || !email) throw new StaffInviteError('Staff email could not be found', 404);
  const existingAccount = Boolean(authUser.user.email_confirmed_at);
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: existingAccount ? 'recovery' : 'invite',
    email,
    options: { redirectTo: `${appUrl()}/admin/set-password` },
  });
  if (linkError || !linkData.properties?.action_link) throw linkError || new Error('Activation link could not be generated');

  const name = staff.display_name || authUser.user.user_metadata?.display_name || '';
  const link = linkData.properties.action_link;
  const subject = existingAccount ? 'Set your Graceland Venues staff password' : 'Activate your Graceland Venues staff account';
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a"><h2 style="color:#0EA5E9">Graceland Venues staff access</h2><p>Hi ${escapeHtml(name || 'there')},</p><p>${existingAccount ? 'An administrator requested a new password setup link for your staff account.' : 'You have been invited to join the Graceland Venues staff portal.'}</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0EA5E9;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">${existingAccount ? 'Set password' : 'Activate account'}</a></p><p>This link expires according to the authentication settings. If you did not expect this email, you can ignore it.</p></div>`;
  await sendEmail({ to: email, subject, html });
  return { email, existingAccount };
}
