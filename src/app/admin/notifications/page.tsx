'use client';

import { PageHeader } from '@/components/admin/AdminShell';
import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Failure = { id: string; notification_type: string; recipient: string | null; error_message: string; created_at: string; retryable?: boolean };

const TYPE_LABELS: Record<string, string> = {
  VOUCHER_ISSUED: 'Voucher email',
  TICKETS_EMAIL_FAILED: 'Tickets email',
  TICKETS_ISSUED_BY_VOUCHER: 'Tickets email (paid by voucher)',
  WALK_IN_TICKETS: 'Walk-in tickets email',
  EFT_INSTRUCTIONS: 'EFT payment instructions',
  STAFF_INVITE: 'Staff invitation',
};

export default function NotificationFailures() {
  const [failures, setFailures] = useState<Failure[]>([]); const [message, setMessage] = useState('Loading failed notifications...'); const [busy, setBusy] = useState('');
  const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
  const load = async () => { const response = await fetch('/api/admin/notifications', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setFailures(data.failures); setMessage(data.failures.length ? '' : 'No failed notifications are waiting for retry.'); };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- Initial data fetch on mount; setState is asynchronous
  useEffect(() => { load().catch(error => setMessage(error.message)); }, []);
  const act = async (id: string, action?: 'dismiss') => {
    if (busy) return;
    setBusy(id);
    try {
      const response = await fetch('/api/admin/notifications', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ failureId: id, action }) });
      const data = await response.json(); setMessage(data.message || data.error); if (response.ok) await load();
    } finally { setBusy(''); }
  };
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <PageHeader eyebrow="Settings" title="Email retries" description="Emails that could not be sent. Retry them once the problem is fixed." />
    {message && <p role="status" style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}
    <div style={{ display: 'grid', gap: 12 }}>{failures.map(failure => <article className="card" key={failure.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <div style={{ flex: '1 1 200px' }}>
        <strong>{TYPE_LABELS[failure.notification_type] || failure.notification_type}</strong>
        <p style={{ fontSize: '0.9rem', wordBreak: 'break-all' }}>{failure.recipient || 'No recipient'} · {new Date(failure.created_at).toLocaleString()}</p>
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', wordBreak: 'break-word' }}>{failure.error_message}</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignSelf: 'flex-start' }}>
        {failure.retryable !== false && <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => act(failure.id)}>{busy === failure.id ? 'Sending…' : 'Retry email'}</button>}
        <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => act(failure.id, 'dismiss')}>Mark resolved</button>
      </div>
    </article>)}</div>
  </main>;
}
