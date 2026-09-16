'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

export default function SetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('Checking your invitation…');
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let active = true;

    async function init() {
      // First, try to pick up tokens from the URL hash (implicit flow fallback).
      // The Supabase browser client does this automatically on creation, but
      // we listen for the resulting auth state change to be sure.
      const { data } = await supabaseBrowser.auth.getSession();
      if (!active) return;

      if (data.session) {
        setReady(true);
        setMessage('Create a password for your staff account.');
        return;
      }

      // If no session yet, the page may have been reached via a direct link
      // or the callback may still be processing. Wait for onAuthStateChange.
    }

    init();

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
      if (session && active) {
        setReady(true);
        setMessage('Create a password for your staff account.');
      }
    });

    // If no session appears within 4 seconds, show an expiry message
    const timeout = setTimeout(() => {
      if (active && !ready) {
        setMessage('This invitation is invalid or has expired. Please ask an administrator to send a new invite.');
      }
    }, 4000);

    return () => {
      active = false;
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) return setMessage('Password must be at least 8 characters long.');
    if (password !== confirmation) return setMessage('Passwords do not match.');
    setSaving(true);
    const { error } = await supabaseBrowser.auth.updateUser({ password });
    if (error) {
      setMessage('We could not set your password. The link may have expired — please request a new invitation.');
      setSaving(false);
      return;
    }
    setSuccess(true);
    setMessage('Your password has been set successfully! Redirecting to the admin portal…');
    setTimeout(() => router.replace('/admin'), 1500);
  };

  return (
    <main className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ color: 'var(--primary)', marginBottom: '0.75rem' }}>Set your staff password</h1>
        <p style={{ color: success ? 'var(--success)' : 'var(--text-muted)', marginBottom: '1.5rem' }}>{message}</p>

        {ready && !success && (
          <form onSubmit={submit} style={{ display: 'grid', gap: '1rem' }}>
            <label>
              New password
              <input
                required
                type="password"
                minLength={8}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="Minimum 8 characters"
                style={{ display: 'block', width: '100%', padding: '0.75rem', marginTop: 5, border: '1px solid var(--border-color)', borderRadius: 8 }}
              />
            </label>
            <label>
              Confirm password
              <input
                required
                type="password"
                minLength={8}
                value={confirmation}
                onChange={event => setConfirmation(event.target.value)}
                placeholder="Re-enter your password"
                style={{ display: 'block', width: '100%', padding: '0.75rem', marginTop: 5, border: '1px solid var(--border-color)', borderRadius: 8 }}
              />
            </label>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Set password and continue'}
            </button>
          </form>
        )}

        {!ready && !success && (
          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <a className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Go to admin portal</a>
          </div>
        )}
      </div>
    </main>
  );
}
