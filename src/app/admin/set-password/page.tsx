'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function SetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [message, setMessage] = useState('Checking your invitation…'); const [ready, setReady] = useState(false); const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    supabaseBrowser.auth.getSession().then(({ data }) => { if (!active) return; setReady(Boolean(data.session)); setMessage(data.session ? 'Create a password for your staff account.' : 'This invitation is invalid or has expired. Please ask an administrator to send a new invite.'); });
    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_event, session) => { if (session) { setReady(true); setMessage('Create a password for your staff account.'); } });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) return setMessage('Password must be at least 8 characters long.');
    if (password !== confirmation) return setMessage('Passwords do not match.');
    setSaving(true); const { error } = await supabaseBrowser.auth.updateUser({ password });
    if (error) { setMessage('We could not set your password. Please request a new invitation.'); setSaving(false); return; }
    router.replace('/admin');
  };
  return <main className="container" style={{ padding: '4rem 1rem' }}><div className="card" style={{ maxWidth: 480, margin: '0 auto' }}><h1 style={{ color: 'var(--primary)', marginBottom: '0.75rem' }}>Set your staff password</h1><p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>{message}</p>{ready && <form onSubmit={submit} style={{ display: 'grid', gap: '1rem' }}><label>New password<input required type="password" minLength={8} value={password} onChange={event => setPassword(event.target.value)} style={{ display: 'block', width: '100%', padding: '0.75rem', marginTop: 5, border: '1px solid var(--border-color)', borderRadius: 8 }} /></label><label>Confirm password<input required type="password" minLength={8} value={confirmation} onChange={event => setConfirmation(event.target.value)} style={{ display: 'block', width: '100%', padding: '0.75rem', marginTop: 5, border: '1px solid var(--border-color)', borderRadius: 8 }} /></label><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Set password and continue'}</button></form>}</div></main>;
}
