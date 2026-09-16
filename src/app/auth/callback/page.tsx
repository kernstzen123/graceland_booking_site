'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function handleCallback() {
      const code = searchParams.get('code');
      const next = searchParams.get('next') || '/admin/set-password';

      if (code) {
        const { error: exchangeError } = await supabaseBrowser.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          if (active) setError('This invitation link is invalid or has expired. Please ask an administrator to send a new invite.');
          return;
        }
        if (active) router.replace(next);
        return;
      }

      // Check for hash fragment tokens (implicit flow fallback)
      const { data } = await supabaseBrowser.auth.getSession();
      if (data.session) {
        if (active) router.replace(next);
        return;
      }

      // Listen for auth state changes in case the session is still being established
      const { data: listener } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
        if (session && active) {
          router.replace(next);
          listener.subscription.unsubscribe();
        }
      });

      // Give it a few seconds, then show error
      setTimeout(() => {
        if (active) {
          setError('This invitation link is invalid or has expired. Please ask an administrator to send a new invite.');
        }
      }, 5000);
    }

    handleCallback();
    return () => { active = false; };
  }, [searchParams, router]);

  return (
    <main className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ color: 'var(--primary)', marginBottom: '0.75rem' }}>
          {error ? 'Link expired' : 'Setting up your account…'}
        </h1>
        {error ? (
          <>
            <p style={{ color: 'var(--danger)', marginBottom: '1.5rem' }}>{error}</p>
            <a className="btn btn-primary" href="/admin">Go to admin portal</a>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>
            Please wait while we verify your invitation…
          </p>
        )}
      </div>
    </main>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<main className="container" style={{ padding: '4rem 1rem' }}><p style={{ textAlign: 'center' }}>Verifying invitation…</p></main>}>
      <CallbackHandler />
    </Suspense>
  );
}
