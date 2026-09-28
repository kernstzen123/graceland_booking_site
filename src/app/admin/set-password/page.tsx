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
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const params = new URLSearchParams(window.location.search);
      const clearUrl = () => window.history.replaceState({}, document.title, window.location.pathname);

      // 1. Check for errors in the URL hash (common if an email scanner consumed the link)
      const hashError = hashParams.get('error_description') || hashParams.get('error');
      if (hashError) {
        if (active) setMessage(`Link error: ${hashError.replace(/\+/g, ' ')} (Ask an administrator to send a new invite)`);
        return;
      }

      // 2. Invite and "resend invite" links from Supabase put the session tokens
      // in the URL hash (#access_token=…). This site's Supabase client uses the
      // PKCE flow and ignores those, so hand them over explicitly.
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      if (accessToken && refreshToken) {
        const { error } = await supabaseBrowser.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        clearUrl(); // never leave tokens in the address bar or browser history
        if (error) {
          if (active) setMessage('This invitation is invalid or has expired. Please ask an administrator to send a new invite.');
          return;
        }
      }

      // 3. Links built from the email template's {{ .TokenHash }} (?token_hash=…&type=invite).
      const tokenHash = params.get('token_hash');
      const linkType = params.get('type');
      if (tokenHash && (linkType === 'invite' || linkType === 'recovery' || linkType === 'magiclink' || linkType === 'email')) {
        const { error } = await supabaseBrowser.auth.verifyOtp({ token_hash: tokenHash, type: linkType });
        clearUrl();
        if (error) {
          if (active) setMessage('This invitation is invalid or has expired. Please ask an administrator to send a new invite.');
          return;
        }
      }

      // 4. Check if Supabase sent a PKCE code in the URL query string
      const code = params.get('code');

      if (code) {
        const { error } = await supabaseBrowser.auth.exchangeCodeForSession(code);
        if (error) {
          if (active) setMessage(`Code exchange error: ${error.message}`);
          return; // Stop here if exchange failed
        }
        
        // Remove the code from the URL so it doesn't get reused if the user refreshes
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      // 5. Use the session established above (or one that already exists)
      const { data } = await supabaseBrowser.auth.getSession();
      if (!active) return;

      if (data.session) {
        setReady(true);
        setMessage('Create a password for your staff account.');
        return;
      }
    }

    init();

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
      if (session && active) {
        setReady(true);
        setMessage('Create a password for your staff account.');
      }
    });

    // If no session appears within 4 seconds, and we haven't shown a specific error yet, show expiry
    const timeout = setTimeout(() => {
      if (active) {
        setReady((currentReady) => {
          if (!currentReady) {
            setMessage((currentMsg) => 
              currentMsg === 'Checking your invitation…' 
                ? 'This invitation is invalid or has expired. Please ask an administrator to send a new invite.' 
                : currentMsg
            );
          }
          return currentReady;
        });
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
