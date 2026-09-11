'use client';

import { FormEvent, useEffect, useState } from 'react';
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
  }, []);

  const loadRole = async (token: string) => {
    try {
      const response = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) { setError(data.error || 'Staff access is required'); await supabaseBrowser.auth.signOut(); return; }
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
  };

  const tryOfflineSession = async () => {
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
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
  };

  const signOut = async () => {
    await clearCachedSession().catch(() => {});
    await supabaseBrowser.auth.signOut();
    window.location.assign('/');
  };

  const logoutButton = session ? <button onClick={signOut} style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 10, padding: '0.55rem 0.8rem', background: 'white', border: '1px solid var(--border-color)', borderRadius: 8, cursor: 'pointer' }}>Log out</button> : null;

  if (loading) return <main className="container" style={{ padding: '4rem 1rem' }}>Loading staff portal…</main>;
  if (!session || !role) return (
    <>{logoutButton}<main className="container" style={{ padding: '4rem 1rem' }}>
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

  if (role === 'SCANNER' && pathname !== '/admin/scanner' && pathname !== '/admin/set-password') return <>{logoutButton}<main className="container" style={{ padding: '4rem 1rem' }}><div className="card"><h1>Gate staff access</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Your role only has access to the ticket scanner.</p><a className="btn btn-primary" href="/admin/scanner">Open scanner</a></div></main></>;
  if (pathname === '/admin/staff' && role !== 'ADMIN') return <>{logoutButton}<main className="container" style={{ padding: '4rem 1rem' }}><div className="card"><h1>Admin access required</h1><p style={{ color: 'var(--text-muted)', margin: '1rem 0' }}>Only administrators can manage staff accounts.</p></div></main></>;

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
    {children}
    {role !== 'SCANNER' && <div style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 10, display: 'flex', gap: 10, flexWrap: 'wrap', maxWidth: 'calc(100vw - 90px)' }}>{role === 'ADMIN' && <a href="/admin/staff" style={{ padding: '0.55rem 0.8rem', background: 'white', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--primary)', fontWeight: 700 }}>Staff management</a>}<a href="/admin/vouchers" style={{ padding: '0.55rem 0.8rem', background: 'white', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--primary)', fontWeight: 700 }}>Vouchers</a><a href="/admin/notifications" style={{ padding: '0.55rem 0.8rem', background: 'white', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--primary)', fontWeight: 700 }}>Email retries</a></div>}
    {logoutButton}
  </>;
}
