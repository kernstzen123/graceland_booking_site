'use client';

import { FormEvent, useEffect, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { cacheSession, getCachedSession, clearCachedSession, initDB } from '@/lib/offline-db';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabaseBrowser.auth.getSession>>['data']['session']>(null);
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [offlineMode, setOfflineMode] = useState(false);
  const pathname = usePathname();

  const tryOfflineSession = useCallback(async () => {
    try {
      const cached = await getCachedSession();
      if (cached) {
        setRole(cached.role);
        setOfflineMode(true);
        // Create a minimal session-like object for child components
        setSession({
          access_token: cached.access_token,
          user: { email: cached.email },
        } as typeof session);
      }
    } catch { /* no cached session available */ }
  }, []);

  const loadRole = useCallback(async (token: string) => {
    try {
      const response = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        // On the set-password page, don't sign out — the user may be setting
        // their password for the first time before their role check succeeds.
        if (pathname !== '/admin/set-password') {
          setError(data.error || 'Staff access is required');
          await supabaseBrowser.auth.signOut();
        }
        return;
      }
      setRole(data.role);
      // Cache session for offline use
      try {
        const sessionData = (await supabaseBrowser.auth.getSession()).data.session;
        if (sessionData) {
          await cacheSession(sessionData, data.role, sessionData.user?.email || '');
        }
      } catch { /* caching is best-effort */ }
    } catch {
      // Network error — try offline fallback
      await tryOfflineSession();
    }
  }, [pathname, tryOfflineSession]);

  useEffect(() => {
    let active = true;

    // Initialize IndexedDB early
    initDB().catch(() => {});

    supabaseBrowser.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        await loadRole(data.session.access_token);
      } else {
        // No active session — try cached session for offline use
        await tryOfflineSession();
      }
      if (active) setLoading(false);
    }).catch(async () => {
      // Network error getting session — try offline fallback
      if (!active) return;
      await tryOfflineSession();
      if (active) setLoading(false);
    });

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        setOfflineMode(false);
        await loadRole(nextSession.access_token);
      } else {
        setRole('');
      }
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [loadRole, tryOfflineSession]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
  };

  const signOut = async () => {
    await clearCachedSession().catch(() => {});
    await supabaseBrowser.auth.signOut();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Intentionally triggering a full reload to clear all client state after signout
    window.location.assign('/');
  };



  if (loading) return <main className="container" style={{ padding: '4rem 1rem' }}>Loading staff portal…</main>;

  // Allow the set-password page to render unconditionally — the invited
  // user may not have a session yet (tokens are in the URL hash) and won't have a role.
  if (pathname === '/admin/set-password') {
    return <>{children}</>;
  }

  if (!session || !role) return (
    <><main className="container" style={{ padding: '4rem 1rem' }}>
      <div className="card" style={{ maxWidth: 430, margin: '0 auto' }}>
        <h1 style={{ color: 'var(--primary)', marginBottom: '0.5rem' }}>Staff Sign In</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>Use your Supabase staff account to access the admin portal.</p>
        <form onSubmit={signIn} style={{ display: 'grid', gap: '1rem' }}>
          <input aria-label="Email" type="email" required placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
          <input aria-label="Password" type="password" required placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} style={{ padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
          <button className="btn btn-primary" type="submit">Sign in</button>
        </form>
        {error && <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
        {!navigator.onLine && <p style={{ color: 'var(--warning)', marginTop: '1rem' }}>You are offline. Sign in requires an internet connection.</p>}
      </div>
    </main></>
  );

  if (role === 'SCANNER' && pathname !== '/admin/scanner' && pathname !== '/admin/walk-ins' && pathname !== '/admin/set-password') return <><main className="container" style={{ padding: '4rem 1rem' }}><div className="card"><h1>Gate staff access</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Your role has access to the ticket scanner and walk-in sales.</p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><a className="btn btn-primary" href="/admin/scanner">Open scanner</a><a className="btn" href="/admin/walk-ins" style={{ border: '1px solid var(--border-color)' }}>Walk-in sales</a></div></div></main><div className="admin-bottom-nav"><div style={{ marginLeft: 'auto' }}><button onClick={signOut} className="btn" style={{ border: '1px solid var(--border-color)' }}>Log out</button></div></div></>;
  if (pathname === '/admin/staff' && role !== 'ADMIN') return <><main className="container" style={{ padding: '4rem 1rem' }}><div className="card"><h1>Admin access required</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Only administrators can manage staff accounts.</p></div></main><div className="admin-bottom-nav"><div style={{ marginLeft: 'auto' }}><button onClick={signOut} className="btn" style={{ border: '1px solid var(--border-color)' }}>Log out</button></div></div></>;

  return <>
    {offlineMode && (
      <div style={{
        background: '#f59e0b',
        color: '#1a1a1a',
        textAlign: 'center',
        padding: '4px 12px',
        fontSize: '0.8rem',
        fontWeight: 700,
      }}>
        ⚡ Offline mode — using cached credentials
      </div>
    )}
    <div className="admin-content-pad">
      {children}
    </div>
    {role !== 'SCANNER' && (
      <div className="admin-bottom-nav">
        <a href="/admin" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Dashboard</a>
        <a href="/admin/walk-ins" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Walk-ins</a>
        <a href="/admin/reports" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Reports</a>
        <a href="/admin/settings" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Prices &amp; dates</a>
        {role === 'ADMIN' && <a href="/admin/staff" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Staff</a>}
        <a href="/admin/vouchers" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Vouchers</a>
        <a href="/admin/notifications" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Email retries</a>
        <div style={{ marginLeft: 'auto' }}><button onClick={signOut} className="btn" style={{ border: '1px solid var(--border-color)' }}>Log out</button></div>
      </div>
    )}
    {role === 'SCANNER' && (
      <div className="admin-bottom-nav">
        <a href="/admin/scanner" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Scanner</a>
        <a href="/admin/walk-ins" className="btn" style={{ border: '1px solid var(--border-color)', color: 'var(--primary)', fontWeight: 700 }}>Walk-in sales</a>
        <div style={{ marginLeft: 'auto' }}><button onClick={signOut} className="btn" style={{ border: '1px solid var(--border-color)' }}>Log out</button></div>
      </div>
    )}
  </>;
}
