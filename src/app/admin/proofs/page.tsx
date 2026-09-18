'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Proof = { id: string; file_url: string; signed_url: string | null; status: string; admin_notes: string | null; uploaded_at: string; bookings?: { reference: string; visit_date: string; total_amount: number; customers?: { first_name: string; last_name: string; email: string } | { first_name: string; last_name: string; email: string }[]; booking_items?: Array<{ quantity: number; subtotal: number; metadata: { name?: string } | null; packages?: Array<{ name: string }>; huts?: Array<{ name: string }> }> } | { reference: string; visit_date: string; total_amount: number; customers?: { first_name: string; last_name: string; email: string } | { first_name: string; last_name: string; email: string }[]; booking_items?: Array<{ quantity: number; subtotal: number; metadata: { name?: string } | null; packages?: Array<{ name: string }>; huts?: Array<{ name: string }> }> }[] };

export default function ReviewProofs() {
  const [status, setStatus] = useState('PENDING');
  const [proofs, setProofs] = useState<Proof[]>([]);
  const [message, setMessage] = useState('Loading proofs…');
  const load = async () => { const session = (await supabaseBrowser.auth.getSession()).data.session; if (!session) return; const res = await fetch(`/api/admin/proofs?status=${status}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' }); const data = await res.json(); if (!res.ok) throw new Error(data.error); setProofs(data.proofs); setMessage(data.proofs.length ? '' : 'No proofs in this queue.'); };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [status]);
  const act = async (proof: Proof, action: 'approve' | 'reject') => { const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings; const reason = action === 'reject' ? window.prompt('Reason for rejection:') : ''; if (action === 'reject' && !reason) return; if (action === 'approve' && !window.confirm(`Approve ${booking?.reference || 'this proof'} and issue tickets?`)) return; const session = (await supabaseBrowser.auth.getSession()).data.session; if (!session) return; const res = await fetch('/api/admin/proofs', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ proofId: proof.id, action, reason }) }); const data = await res.json(); if (!res.ok) { setMessage(data.error); return; } await load(); };
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header">
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>FINANCE OPERATIONS</p><h1>Proofs of payment</h1></div>
      <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: 8 }}><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select>
    </div>
    {message && <div className="card" style={{ marginBottom: '1rem', color: 'var(--text-muted)' }}>{message}</div>}
    <div style={{ display: 'grid', gap: '1rem' }}>{proofs.map(proof => { const booking = Array.isArray(proof.bookings) ? proof.bookings[0] : proof.bookings; const customer = booking && (Array.isArray(booking.customers) ? booking.customers[0] : booking.customers); return <article className="card" key={proof.id}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ color: 'var(--primary)' }}>{booking?.reference}</h2>
        <p><strong>{customer ? `${customer.first_name} ${customer.last_name}` : 'Customer'}</strong></p>
        <p style={{ wordBreak: 'break-all', color: 'var(--text-muted)' }}>{customer?.email}</p>
        <p>Visit: {booking?.visit_date} · Amount: R {Number(booking?.total_amount || 0).toFixed(2)}</p>
        {booking?.booking_items?.map((item, index) => <p key={index} style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{item.packages?.[0]?.name || item.huts?.[0]?.name || item.metadata?.name || 'Booking item'} × {item.quantity} · R {Number(item.subtotal || 0).toFixed(2)}</p>)}
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Uploaded {new Date(proof.uploaded_at).toLocaleString()}</p>
        {proof.signed_url && <a href={proof.signed_url} target="_blank" rel="noreferrer" className="btn" style={{ marginTop: '0.75rem', border: '1px solid var(--border-color)', display: 'inline-flex' }}>Preview document</a>}
      </div>
      {status === 'PENDING' && <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}><button className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', flex: '1 1 120px' }} onClick={() => act(proof, 'reject')}>Reject</button><button className="btn btn-primary" style={{ flex: '1 1 120px' }} onClick={() => act(proof, 'approve')}>Approve &amp; issue tickets</button></div>}
    </article>; })}</div>
    <a href="/admin" className="btn" style={{ marginTop: '2rem', border: '1px solid var(--border-color)' }}>Back to dashboard</a>
  </main>;
}
