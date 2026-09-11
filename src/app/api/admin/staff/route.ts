import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { AdminAuthError, requireAdmin, writeAudit } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';

const roles = ['ADMIN', 'MANAGER', 'SCANNER'] as const;
const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

async function sendActivationEmail(email: string, name: string, link: string, existingAccount: boolean) {
  const subject = existingAccount ? 'Set your Graceland Venues staff password' : 'Activate your Graceland Venues staff account';
  const safeName = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0f172a"><h2 style="color:#0EA5E9">Graceland Venues staff access</h2><p>Hi ${safeName || 'there'},</p><p>${existingAccount ? 'An administrator requested a new password setup link for your staff account.' : 'You have been invited to join the Graceland Venues staff portal.'}</p><p><a href="${link}" style="display:inline-block;background:#0EA5E9;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">${existingAccount ? 'Set password' : 'Activate account'}</a></p><p>This link expires according to the authentication settings. If you did not expect this email, you can ignore it.</p></div>`;
  const fromEmail = process.env.NODE_ENV !== 'production'
    ? (process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER || 'bookings@gracelandvenues.co.za')
    : (process.env.EMAIL_FROM_ADDRESS || 'bookings@gracelandvenues.co.za');
  if (process.env.NODE_ENV !== 'production') {
    const host = process.env.SMTP_HOST; const user = process.env.SMTP_USER; const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) throw new Error('SMTP is not configured');
    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({ host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465, auth: { user, pass } });
    await transporter.sendMail({ from: `Graceland Venues <${fromEmail}>`, to: email, subject, html });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email provider is not configured');
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: `Graceland Venues <${fromEmail}>`, to: [email], subject, html }) });
  if (!response.ok) throw new Error('Email provider rejected the message');
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN']);
    const query = new URL(request.url).searchParams.get('q')?.trim().toLowerCase() || '';
    const roleFilter = new URL(request.url).searchParams.get('role')?.toUpperCase();
    const { data: roleRows, error } = await supabase.from('admin_roles').select('id,role,display_name,active,created_at,updated_at').order('created_at', { ascending: false });
    if (error) throw error;
    const { data: users, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) throw usersError;
    const entries = (roleRows || []).map(row => {
      const user = users.users.find(candidate => candidate.id === row.id);
      return { ...row, email: user?.email || '', last_login: user?.last_sign_in_at || null, name: row.display_name || user?.user_metadata?.display_name || user?.email || 'Staff member' };
    }).filter(row => (!query || `${row.name} ${row.email}`.toLowerCase().includes(query)) && (!roleFilter || row.role === roleFilter));
    return NextResponse.json({ success: true, staff: entries });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Staff list error', error);
    return NextResponse.json({ success: false, error: 'Could not load staff members' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const body = await request.json();
    if (body.action === 'resend_invite') {
      const userId = typeof body.userId === 'string' ? body.userId : '';
      const { data: staff } = await supabase.from('admin_roles').select('id,display_name').eq('id', userId).single();
      if (!staff) return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 });
      const { data: authUser, error: authUserError } = await supabase.auth.admin.getUserById(userId);
      if (authUserError || !authUser.user?.email) return NextResponse.json({ success: false, error: 'Staff email could not be found' }, { status: 404 });
      const existingAccount = Boolean(authUser.user.email_confirmed_at);
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: existingAccount ? 'recovery' : 'invite',
        email: authUser.user.email,
        options: { redirectTo: `${appUrl()}/admin/set-password` },
      });
      if (linkError || !linkData.properties?.action_link) throw linkError || new Error('Activation link could not be generated');
      await sendActivationEmail(authUser.user.email, staff.display_name || authUser.user.user_metadata?.display_name || '', linkData.properties.action_link, existingAccount);
      await writeAudit(user.id, 'RESEND_STAFF_INVITE', 'staff', userId, { email: authUser.user.email });
      return NextResponse.json({ success: true, message: existingAccount ? 'Password setup link sent' : 'Activation link sent' });
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
    const role = typeof body.role === 'string' ? body.role.toUpperCase() : '';
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !roles.includes(role as typeof roles[number])) return NextResponse.json({ success: false, error: 'Enter a valid name, email, and staff role.' }, { status: 400 });
    let invitedUserId = body.userId as string | undefined;
    if (!invitedUserId) {
      const { data: users, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (usersError) throw usersError;
      const existingUser = users.users.find(candidate => candidate.email?.toLowerCase() === email);
      if (existingUser) invitedUserId = existingUser.id;
      else {
        const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, { data: { display_name: name }, redirectTo: `${appUrl()}/admin/set-password` });
        if (inviteError || !invite.user) throw inviteError || new Error('Invite could not be sent');
        invitedUserId = invite.user.id;
      }
    }
    const { data: prior } = await supabase.from('admin_roles').select('role').eq('id', invitedUserId).maybeSingle();
    const { error } = await supabase.from('admin_roles').upsert({ id: invitedUserId, role, display_name: name, active: true, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) throw error;
    await writeAudit(user.id, prior ? 'UPDATE_STAFF' : 'INVITE_STAFF', 'staff', invitedUserId, { email, role, name });
    return NextResponse.json({ success: true, message: prior ? 'Staff member updated and reactivated' : 'Invitation sent' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Staff invite error', error);
    return NextResponse.json({ success: false, error: 'Could not invite staff member. Check the email and try again.' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const body = await request.json(); const userId = typeof body.userId === 'string' ? body.userId : ''; const role = typeof body.role === 'string' ? body.role.toUpperCase() : undefined; const active = typeof body.active === 'boolean' ? body.active : undefined; const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : undefined;
    if (!userId || userId === user.id && active === false) return NextResponse.json({ success: false, error: 'You cannot deactivate your own admin account.' }, { status: 400 });
    if (role && !roles.includes(role as typeof roles[number])) return NextResponse.json({ success: false, error: 'Invalid staff role' }, { status: 400 });
    if (userId === user.id && role && role !== 'ADMIN') return NextResponse.json({ success: false, error: 'You cannot remove your own admin role.' }, { status: 400 });
    const { data: existing, error: existingError } = await supabase.from('admin_roles').select('id,role,active,display_name').eq('id', userId).single();
    if (existingError || !existing) return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    if (email !== undefined && !/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ success: false, error: 'Enter a valid email address' }, { status: 400 });
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }; if (role) update.role = role; if (active !== undefined) update.active = active; if (name !== undefined) update.display_name = name;
    const { error } = await supabase.from('admin_roles').update(update).eq('id', userId); if (error) throw error;
    if (email !== undefined || name !== undefined) {
      const { error: authUpdateError } = await supabase.auth.admin.updateUserById(userId, { ...(email !== undefined ? { email } : {}), ...(name !== undefined ? { user_metadata: { display_name: name } } : {}) });
      if (authUpdateError) throw authUpdateError;
    }
    if (active === false) await supabase.auth.admin.signOut(userId, 'global');
    await writeAudit(user.id, active === false ? 'DEACTIVATE_STAFF' : active === true ? 'REACTIVATE_STAFF' : 'CHANGE_STAFF_ROLE', 'staff', userId, { before: existing, after: update });
    return NextResponse.json({ success: true, message: active === false ? 'Staff member deactivated' : active === true ? 'Staff member reactivated' : 'Staff member updated' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Staff update error', error);
    return NextResponse.json({ success: false, error: 'Could not update staff member' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireAdmin(request, ['ADMIN']);
    const userId = new URL(request.url).searchParams.get('userId') || '';
    if (!userId || userId === user.id) return NextResponse.json({ success: false, error: 'You cannot delete your own admin account.' }, { status: 400 });
    const { data: target } = await supabase.from('admin_roles').select('id,role,active,display_name').eq('id', userId).single();
    if (!target) return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 });
    if (target.role === 'ADMIN' && target.active) {
      const { count } = await supabase.from('admin_roles').select('id', { count: 'exact', head: true }).eq('role', 'ADMIN').eq('active', true);
      if ((count || 0) <= 1) return NextResponse.json({ success: false, error: 'At least one active admin must remain.' }, { status: 400 });
    }
    const { data: targetUser } = await supabase.auth.admin.getUserById(userId);
    await writeAudit(user.id, 'DELETE_STAFF', 'staff', userId, { email: targetUser.user?.email || null, name: target.display_name || null });
    const { error: roleDeleteError } = await supabase.from('admin_roles').delete().eq('id', userId);
    if (roleDeleteError) throw roleDeleteError;
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);
    if (authDeleteError) throw authDeleteError;
    return NextResponse.json({ success: true, message: 'Staff member permanently deleted' });
  } catch (error) {
    if (error instanceof AdminAuthError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error('Staff delete error', error);
    return NextResponse.json({ success: false, error: 'Could not delete staff member' }, { status: 500 });
  }
}
