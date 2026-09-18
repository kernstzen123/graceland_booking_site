'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Redemption = { id: string; booking_id: string; amount_used: number; created_at: string; bookings?: { reference: string; visit_date: string } | Array<{ reference: string; visit_date: string }> };
type Voucher = { id: string; credit_code: string; original_amount: number; remaining_balance: number; status: string; created_at: string; issued_by?: string; bookings?: { reference: string; customers?: { first_name: string; last_name: string; email: string } | Array<{ first_name: string; last_name: string; email: string }> } | Array<{ reference: string; customers?: { first_name: string; last_name: string; email: string } | Array<{ first_name: string; last_name: string; email: string }> }>; credit_redemptions?: Redemption[] };
type Summary = { totalIssued: number; totalRedeemed: number; outstanding: number; totalVoided: number };
type Failure = { id: string; recipient: string | null; error_message: string; created_at: string };
const first = <T,>(value: T | T[] | undefined) => Array.isArray(value) ? value[0] : value;

export default function VouchersAdmin() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]); const [summary, setSummary] = useState<Summary | null>(null); const [failures, setFailures] = useState<Failure[]>([]); const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [message, setMessage] = useState('Loading vouchers...'); const [busy, setBusy] = useState(''); const [expanded, setExpanded] = useState<string | null>(null);
  const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
  const load = async () => { const headers = { Authorization: `Bearer ${await token()}` }; const [listResponse, summaryResponse, failuresResponse] = await Promise.all([fetch(`/api/admin/vouchers?q=${encodeURIComponent(query)}&status=${status}`, { headers, cache: 'no-store' }), fetch('/api/admin/vouchers/summary', { headers, cache: 'no-store' }), fetch('/api/admin/notifications', { headers, cache: 'no-store' })]); const list = await listResponse.json(); const totals = await summaryResponse.json(); const failed = await failuresResponse.json(); if (!listResponse.ok) throw new Error(list.error); setVouchers(list.vouchers); setSummary(totals.summary); setFailures(failed.failures || []); setMessage(list.vouchers.length ? '' : 'No vouchers found.'); };
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [status]);
  const retry = async (failureId: string) => { if (busy) return; setBusy('retry'); setMessage('Retrying email... please wait.'); try { const response = await fetch('/api/admin/notifications', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ failureId }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) await load(); } finally { setBusy(''); } };
  const voidVoucher = async (voucher: Voucher) => { if (busy) return; const reason = window.prompt('Reason for voiding this voucher:'); if (!reason?.trim() || !window.confirm(`Permanently void ${voucher.credit_code}? Its remaining balance will be retained for audit purposes.`)) return; setBusy('void'); setMessage('Voiding voucher... please wait.'); try { const response = await fetch(`/api/admin/vouchers/${voucher.id}/void`, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) await load(); } finally { setBusy(''); } };
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header"><div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>FINANCE OPERATIONS</p><h1>Rebooking vouchers</h1></div><a className="btn" href="/admin/bookings" style={{ border: '1px solid var(--border-color)' }}>All bookings</a></div>
    {summary && <div className="admin-stats">{[['Outstanding', summary.outstanding], ['Total issued', summary.totalIssued], ['Total redeemed', summary.totalRedeemed], ['Total voided', summary.totalVoided]].map(([label, value]) => <div className="card" key={String(label)}><p style={{ color: 'var(--text-muted)' }}>{label}</p><strong style={{ fontSize: '1.6rem', color: label === 'Outstanding' ? 'var(--warning)' : 'var(--primary)' }}>R {Number(value).toFixed(2)}</strong></div>)}</div>}
    <div className="card" style={{ marginBottom: '1rem' }}><form onSubmit={event => { event.preventDefault(); load().catch(error => setMessage(error.message)); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search code, customer, email" style={{ flex: '1 1 160px', padding: 10 }} /><select value={status} onChange={event => setStatus(event.target.value)} style={{ padding: 10 }}><option value="">All statuses</option><option value="active">Active</option><option value="depleted">Depleted</option><option value="void">Void</option></select><button className="btn btn-primary">Search</button></form></div>
    {failures.length > 0 && <div className="card" style={{ marginBottom: '1rem', border: '1px solid var(--danger)' }}><h2>Failed voucher emails</h2>{failures.map(failure => <div key={failure.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border-color)', padding: '0.75rem 0', alignItems: 'center' }}><span style={{ flex: '1 1 200px' }}>{failure.recipient || 'Unknown recipient'}<br /><small style={{ color: 'var(--danger)' }}>{failure.error_message}</small></span><button className="btn" onClick={() => retry(failure.id)} style={{ border: '1px solid var(--border-color)' }}>Retry email</button></div>)}</div>}
    {message && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}
    <div style={{ display: 'grid', gap: '0.75rem' }}>{vouchers.map(voucher => {
      const booking = first(voucher.bookings); const customer = booking && first(booking.customers); const redemptions = voucher.credit_redemptions || []; const lastUsed = redemptions.length ? redemptions.reduce((latest, item) => item.created_at > latest ? item.created_at : latest, redemptions[0].created_at) : null;
      return <div className="card" key={voucher.id}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <p style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '1.1rem' }}>{voucher.credit_code}</p>
            <p>{customer ? `${customer.first_name} ${customer.last_name}` : 'Customer'}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', wordBreak: 'break-all' }}>{customer?.email}</p>
          </div>
          <span style={{ padding: '0.3rem 0.6rem', borderRadius: 20, fontSize: '0.8rem', fontWeight: 700, background: voucher.status === 'active' ? '#dcfce7' : voucher.status === 'void' ? '#fee2e2' : '#e2e8f0' }}>{voucher.status}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem', marginTop: '0.75rem', padding: '0.75rem', background: 'var(--bg-color)', borderRadius: 8, fontSize: '0.9rem' }}>
          <div><p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Original</p><strong>R {Number(voucher.original_amount).toFixed(2)}</strong></div>
          <div><p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Remaining</p><strong>R {Number(voucher.remaining_balance).toFixed(2)}</strong></div>
          <div><p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Issued</p><strong>{new Date(voucher.created_at).toLocaleDateString()}</strong></div>
          <div><p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Last used</p><strong>{lastUsed ? new Date(lastUsed).toLocaleDateString() : 'Never'}</strong></div>
        </div>
        {voucher.issued_by && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 6 }}>Issued by: {voucher.issued_by}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: '0.75rem', flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setExpanded(expanded === voucher.id ? null : voucher.id)} style={{ border: '1px solid var(--border-color)', flex: '1 1 100px' }}>{expanded === voucher.id ? 'Hide' : 'History'}</button>
          {voucher.status === 'active' && <button className="btn" onClick={() => voidVoucher(voucher)} style={{ color: 'var(--danger)', border: '1px solid var(--danger)', flex: '1 1 100px' }}>Void</button>}
        </div>
        {expanded === voucher.id && <div style={{ marginTop: 10 }}>{redemptions.length ? redemptions.map(redemption => { const usedBooking = first(redemption.bookings); return <p key={redemption.id} style={{ borderTop: '1px solid var(--border-color)', padding: '6px 0', fontSize: 13 }}>{usedBooking?.reference || redemption.booking_id} · R {Number(redemption.amount_used).toFixed(2)} · {new Date(redemption.created_at).toLocaleString()}</p>; }) : <p style={{ color: 'var(--text-muted)' }}>No redemptions.</p>}</div>}
      </div>;
    })}</div>
  </main>;
}
