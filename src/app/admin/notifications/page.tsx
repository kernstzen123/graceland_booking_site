'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Failure = { id: string; notification_type: string; recipient: string | null; error_message: string; created_at: string };
export default function NotificationFailures() {
  const [failures, setFailures] = useState<Failure[]>([]); const [message, setMessage] = useState('Loading failed notifications...');
  const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
  const load = async () => { const response = await fetch('/api/admin/notifications', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setFailures(data.failures); setMessage(data.failures.length ? '' : 'No failed notifications are waiting for retry.'); };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  const retry = async (id: string) => { const response = await fetch('/api/admin/notifications', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ failureId: id }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) await load(); };
  return <main className="container" style={{ padding: '2rem 1rem' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}><div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>OPERATIONS</p><h1>Failed notifications</h1></div><a className="btn" href="/admin/vouchers">Vouchers</a></div>{message && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}<div style={{ display: 'grid', gap: 12 }}>{failures.map(failure => <article className="card" key={failure.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><div><strong>{failure.notification_type}</strong><p>{failure.recipient || 'No recipient'} · {new Date(failure.created_at).toLocaleString()}</p><p style={{ color: 'var(--danger)' }}>{failure.error_message}</p></div><button className="btn btn-primary" onClick={() => retry(failure.id)}>Retry email</button></article>)}</div></main>;
}
