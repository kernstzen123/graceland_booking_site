'use client';

import { FormEvent, useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { cacheSession, getCachedSession, clearCachedSession, initDB } from '@/lib/offline-db';
import Link from 'next/link';
import { AdminShell } from '@/components/admin/AdminShell';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabaseBrowser.auth.getSession>>['data']['session']>(null);
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [offlineMode, setOfflineMode] = useState(false);
  const pathname = usePathname();
  // Read the current path inside loadRole without making it a dependency:
  // otherwise every client-side navigation would re-run the session check.
  const pathnameRef = useRef(pathname);
  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);

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
        if (pathnameRef.current !== '/admin/set-password') {
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
  }, [tryOfflineSession]);

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

    const { data: listener } = supabaseBrowser.auth.onAuthStateChange(async (event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        setOfflineMode(false);
        // The initial session is already checked above, and token refreshes do not
        // change the staff role, so only re-check the role when someone signs in.
        if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
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



  if (loading) return <main className="admin-auth-screen"><p style={{ color: 'var(--text-muted)' }}>Loading staff portal…</p></main>;

  // Allow the set-password page to render unconditionally — the invited
  // user may not have a session yet (tokens are in the URL hash) and won't have a role.
  if (pathname === '/admin/set-password') {
    return <>{children}</>;
  }

  if (!session || !role) return (
    <main className="admin-auth-screen">
      <div className="card admin-auth-card">
        <div className="admin-brand" style={{ marginBottom: '1.25rem' }}><span className="admin-brand-mark">G</span><span>Graceland<small>Staff portal</small></span></div>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '0.35rem' }}>Sign in</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.25rem', fontSize: '0.9rem' }}>Use your staff account to access the portal.</p>
        <form onSubmit={signIn} style={{ display: 'grid', gap: '0.75rem' }}>
          <input aria-label="Email" type="email" autoComplete="username" required placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="field-input" />
          <input aria-label="Password" type="password" autoComplete="current-password" required placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="field-input" />
          <button className="btn btn-primary" type="submit" style={{ marginTop: '0.25rem' }}>Sign in</button>
        </form>
        {error && <p role="alert" style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
        {!navigator.onLine && <p style={{ color: 'var(--warning-text)', marginTop: '1rem' }}>You are offline. Sign in requires an internet connection.</p>}
      </div>
    </main>
  );

  const staffRole = (['ADMIN', 'MANAGER', 'SCANNER'].includes(role) ? role : 'SCANNER') as 'ADMIN' | 'MANAGER' | 'SCANNER';
  const gateOnly = staffRole === 'SCANNER' && pathname !== '/admin/scanner' && pathname !== '/admin/walk-ins';
  const adminOnly = pathname === '/admin/staff' && staffRole !== 'ADMIN';

  return <AdminShell role={staffRole} email={session.user?.email || ''} offlineMode={offlineMode} onSignOut={signOut}>
    {gateOnly ? <main className="container" style={{ padding: '2rem 1rem' }}><div className="card"><h1>Gate staff access</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Your role has access to the ticket scanner and walk-in sales.</p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Link className="btn btn-primary" href="/admin/scanner">Open scanner</Link><Link className="btn btn-secondary" href="/admin/walk-ins">Walk-in sales</Link></div></div></main>
      : adminOnly ? <main className="container" style={{ padding: '2rem 1rem' }}><div className="card"><h1>Admin access required</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Only administrators can manage staff accounts.</p></div></main>
      : children}
  </AdminShell>;
}
