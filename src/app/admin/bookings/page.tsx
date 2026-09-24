'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import { DownloadIcon } from '@/components/icons';
import Link from 'next/link';

type Customer = { first_name: string; last_name: string; email: string; phone: string };
type Booking = { id: string; reference: string; visit_date: string; status: string; payment_method: string | null; total_amount: number; people_count: number; created_at: string; refunded_at?: string | null; voucher_issued?: boolean; customers?: Customer | Customer[]; booking_items?: Array<{ quantity: number; subtotal: number; metadata: { name?: string } | null; packages?: Array<{ name: string }>; huts?: Array<{ name: string }> }>; tickets?: Array<{ id: string; ticket_uid: string; status: string }> };
type ListBooking = Pick<Booking, 'id' | 'reference' | 'visit_date' | 'status' | 'payment_method' | 'total_amount' | 'people_count' | 'created_at' | 'voucher_issued'> & { customers?: Partial<Customer> };
type Action = 'resend_tickets' | 'delete' | 'mark_paid' | 'refund' | 'cancel_ticket';
const customerOf = (booking: Booking) => Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
const STATUS_FILTERS = [{ value: '', label: 'All statuses' }, { value: 'PAID', label: 'Paid' }, { value: 'PENDING', label: 'Awaiting payment' }, { value: 'CANCELLED', label: 'Cancelled / refunded' }, { value: 'FAILED', label: 'Payment failed' }];

export default function BookingsAdmin() {
  const [query, setQuery] = useState(''); const [bookings, setBookings] = useState<ListBooking[]>([]); const [selected, setSelected] = useState<Booking | null>(null); const [message, setMessage] = useState('Loading bookings...');
  const [statusFilter, setStatusFilter] = useState(''); const [dateFilter, setDateFilter] = useState(''); const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [pageSize, setPageSize] = useState(50); const [loadingDetail, setLoadingDetail] = useState(''); const [toast, setToast] = useState(''); const [busy, setBusy] = useState(''); const [refundDate, setRefundDate] = useState(new Date().toISOString().slice(0, 10));
  const [showExport, setShowExport] = useState(false); const [exportMode, setExportMode] = useState<'all' | 'range'>('all'); const [exportFrom, setExportFrom] = useState(''); const [exportTo, setExportTo] = useState(''); const [exporting, setExporting] = useState(false);
  const { confirm, dialog } = useConfirm();
  const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
  // The list holds one page of slim rows; the full booking loads when it is opened.
  const load = useCallback(async (options: { page?: number; search?: string; status?: string; date?: string } = {}) => {
    const params = new URLSearchParams({ page: String(options.page ?? 1) });
    if (options.search) params.set('q', options.search);
    if (options.status) params.set('status', options.status);
    if (options.date) params.set('date', options.date);
    const response = await fetch(`/api/admin/bookings?${params}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setBookings(data.bookings); setTotal(data.total); setPageSize(data.pageSize); setPage(data.page);
    setMessage(data.bookings.length ? '' : 'No bookings found.');
  }, []);
  const reload = (nextPage = page) => load({ page: nextPage, search: query.trim(), status: statusFilter, date: dateFilter }).catch(error => setMessage(error.message));
  const openBooking = async (id: string) => {
    setLoadingDetail(id);
    try {
      const response = await fetch(`/api/admin/bookings?id=${id}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) { setMessage(data.error || 'Booking could not be loaded'); return; }
      setSelected(data.booking);
    } finally { setLoadingDetail(''); }
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Reload page 1 when a filter changes; setState happens after the request
  useEffect(() => { load({ page: 1, search: query.trim(), status: statusFilter, date: dateFilter }).catch(error => setMessage(error.message)); }, [statusFilter, dateFilter]); // eslint-disable-line react-hooks/exhaustive-deps -- the search box only applies on submit
  const showToast = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 6000); };
  const action = async (type: Action, ticketId?: string, deductionPercentage?: number) => {
    if (!selected || busy) return;
    let reason: string | null = null;
    if (type === 'delete') {
      const result = await confirm({ title: 'Delete booking', message: `Permanently delete booking ${selected.reference}? This cannot be undone.`, confirmLabel: 'Delete booking', tone: 'danger', promptLabel: 'Reason (optional)', promptPlaceholder: 'Internal note for the audit log', promptRequired: false });
      if (!result.confirmed) return;
      reason = result.value || null;
    } else if (type === 'mark_paid') {
      const result = await confirm({ title: 'Mark booking as paid', message: `Mark booking ${selected.reference} as paid and issue tickets?`, confirmLabel: 'Mark as paid', tone: 'primary', promptLabel: 'Reason (optional)', promptPlaceholder: 'Internal note for the audit log', promptRequired: false });
      if (!result.confirmed) return;
      reason = result.value || null;
    } else if (type === 'resend_tickets') {
      const result = await confirm({ title: 'Resend tickets', message: `Resend tickets for ${selected.reference} to the customer's email?`, confirmLabel: 'Resend tickets', tone: 'primary' });
      if (!result.confirmed) return;
    } else if (type === 'cancel_ticket') {
      const result = await confirm({ title: 'Invalidate ticket', message: 'This ticket will no longer scan as valid at the gate. This cannot be undone.', confirmLabel: 'Invalidate ticket', tone: 'danger', promptLabel: 'Reason (optional)', promptPlaceholder: 'Internal note for the audit log', promptRequired: false });
      if (!result.confirmed) return;
      reason = result.value || null;
    }
    setBusy(type); setMessage(type === 'refund' ? 'Issuing voucher refund... please wait.' : type === 'resend_tickets' ? 'Resending tickets...' : 'Processing booking action... please wait.');
    try {
      let endpoint: string;
      let body: string | undefined;
      if (type === 'resend_tickets') {
        endpoint = `/api/admin/bookings/${selected.id}/resend-tickets`;
        body = undefined;
      } else if (type === 'refund') {
        endpoint = `/api/admin/bookings/${selected.id}/refund`;
        body = JSON.stringify({ deductionPercentage: deductionPercentage || 0 });
      } else {
        endpoint = '/api/admin/bookings';
        body = JSON.stringify({ bookingId: selected.id, action: type, ticketId, reason });
      }
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body });
      const data = await response.json(); setMessage(data.message || data.error); if (!response.ok) return;
      if (type === 'delete') setSelected(null); else await openBooking(selected.id);
      await reload();
      if (type === 'resend_tickets') showToast('Tickets resent successfully');
      if (type === 'refund') showToast(data.emailSent ? 'Voucher issued and email sent' : 'Voucher issued; email queued for retry');
    } finally { setBusy(''); }
  };
  const refundAll = async () => {
    if (busy) return;
    const previewResponse = await fetch('/api/admin/bookings/refund-all', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ date: refundDate, preview: true }) });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) return setMessage(preview.error || 'Could not check bookings for that date.');
    if (!preview.count) return setMessage('No paid, unrefunded bookings found for that date.');
    const result = await confirm({ title: 'Refund all bookings for date', message: `Issue vouchers for ${preview.count} bookings on ${refundDate}, totalling R ${Number(preview.total).toFixed(2)}? This will cancel them and invalidate their tickets.`, confirmLabel: 'Issue vouchers', tone: 'danger' });
    if (!result.confirmed) return;
    setBusy('refund-all'); setMessage('Issuing vouchers for the selected date... please wait.');
    try { const response = await fetch('/api/admin/bookings/refund-all', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ date: refundDate }) }); const data = await response.json(); setMessage(data.message || data.error); if (response.ok) { showToast(data.message); await reload(); if (selected) await openBooking(selected.id); } } finally { setBusy(''); }
  };
  const exportBookings = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportMode === 'range') {
        if (exportFrom) params.set('date_from', exportFrom);
        if (exportTo) params.set('date_to', exportTo);
      }
      const accessToken = await token();
      const response = await fetch(`/api/admin/export-excel?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) { const data = await response.json().catch(() => ({ error: 'Export failed' })); showToast(data.error || 'Export failed'); return; }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      const disposition = response.headers.get('Content-Disposition');
      a.download = disposition?.match(/filename="(.+)"/)?.[1] || 'graceland-bookings.xlsx';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      showToast('Excel file downloaded successfully');
      setShowExport(false);
    } catch { showToast('Export failed — please try again'); }
    finally { setExporting(false); }
  };
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    {toast && <div role="status" style={{ position: 'fixed', top: 24, right: 24, left: 24, zIndex: 20, background: '#065f46', color: 'white', padding: '1rem 1.25rem', borderRadius: 10, textAlign: 'center' }}>✓ {toast}</div>}
    <div className="admin-header">
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>OPERATIONS</p><h1>All bookings</h1></div>
      <div className="admin-nav"><button className="btn" onClick={() => { setExportMode('all'); setExportFrom(''); setExportTo(''); setShowExport(true); }} style={{ background: 'var(--primary)', color: 'white', border: 'none', gap: 6 }}><DownloadIcon size={15} /> Export</button><Link className="btn" href="/admin/vouchers" style={{ border: '1px solid var(--border-color)' }}>Vouchers</Link><Link className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Dashboard</Link></div>
    </div>
    {/* ── Export Modal ─── */}
    {showExport && <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowExport(false); }}>
      <div className="modal-card" role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>Export Bookings</h2>
          <button className="modal-close" onClick={() => setShowExport(false)} aria-label="Close">✕</button>
        </div>
        <p className="modal-message">Download an Excel file with all booking details, customer info, items, and ticket IDs.</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button onClick={() => setExportMode('all')} className="btn" style={{ flex: 1, background: exportMode === 'all' ? 'var(--primary)' : 'transparent', color: exportMode === 'all' ? 'white' : 'var(--text-main)', border: `1px solid ${exportMode === 'all' ? 'var(--primary)' : 'var(--border-color)'}`, transition: 'all 0.15s' }}>All Bookings</button>
          <button onClick={() => setExportMode('range')} className="btn" style={{ flex: 1, background: exportMode === 'range' ? 'var(--primary)' : 'transparent', color: exportMode === 'range' ? 'white' : 'var(--text-main)', border: `1px solid ${exportMode === 'range' ? 'var(--primary)' : 'var(--border-color)'}`, transition: 'all 0.15s' }}>Date Range</button>
        </div>
        {exportMode === 'range' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>From<input type="date" value={exportFrom} onChange={e => setExportFrom(e.target.value)} style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 8 }} /></label>
          <label style={{ display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>To<input type="date" value={exportTo} onChange={e => setExportTo(e.target.value)} style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 8 }} /></label>
        </div>}
        {exportMode === 'range' && !exportFrom && !exportTo && <p style={{ color: 'var(--warning)', fontSize: '0.8rem', marginBottom: 12 }}>Select at least one date to filter, or switch to &quot;All Bookings&quot;.</p>}
        <button className="btn btn-primary" disabled={exporting || (exportMode === 'range' && !exportFrom && !exportTo)} onClick={exportBookings} style={{ width: '100%', opacity: exporting || (exportMode === 'range' && !exportFrom && !exportTo) ? 0.6 : 1, gap: 8 }}>{exporting ? 'Generating…' : <><DownloadIcon size={15} /> Download Excel</>}</button>
      </div>
    </div>}
    <div className="card" style={{ marginBottom: '1rem' }}>
      <form onSubmit={event => { event.preventDefault(); reload(1); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ref, ticket, name, or email" style={{ flex: '1 1 200px', padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
        <select aria-label="Status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} style={{ padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>{STATUS_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input aria-label="Visit date" type="date" value={dateFilter} onChange={event => setDateFilter(event.target.value)} style={{ padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
        {dateFilter && <button type="button" className="btn" onClick={() => setDateFilter('')} style={{ border: '1px solid var(--border-color)' }}>Any date</button>}
        <button className="btn btn-primary">Search</button>
      </form>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}><label style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>Refund all for <input type="date" value={refundDate} onChange={event => setRefundDate(event.target.value)} style={{ padding: 8, marginLeft: 4 }} /></label><button className="btn" onClick={refundAll} style={{ color: '#b91c1c', border: '1px solid #b91c1c' }}>Refund all for date</button></div>
    </div>
    {message && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}
    <div className={`admin-panels${selected ? ' has-detail' : ''}`}>
      <div style={{ display: 'grid', gap: '0.75rem', alignContent: 'start' }}>
        {total > 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} bookings</p>}
        {bookings.map(booking => <button key={booking.id} onClick={() => openBooking(booking.id)} aria-busy={loadingDetail === booking.id} style={{ textAlign: 'left', background: selected?.id === booking.id ? '#e0f2fe' : 'white', border: '1px solid var(--border-color)', borderRadius: 10, padding: '1rem', opacity: loadingDetail === booking.id ? 0.6 : 1 }}><strong style={{ color: 'var(--primary)' }}>{booking.reference}</strong><p>{booking.customers?.first_name} {booking.customers?.last_name}</p><p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{booking.visit_date} · R {Number(booking.total_amount).toFixed(2)} · {booking.voucher_issued ? 'Voucher issued' : booking.status}</p></button>)}
        {total > pageSize && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button className="btn" disabled={page <= 1} onClick={() => reload(page - 1)} style={{ border: '1px solid var(--border-color)' }}>← Newer</button>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Page {page} of {Math.ceil(total / pageSize)}</span>
          <button className="btn" disabled={page * pageSize >= total} onClick={() => reload(page + 1)} style={{ border: '1px solid var(--border-color)' }}>Older →</button>
        </div>}
      </div>
      {selected && <BookingDetail booking={selected} onAction={action} />}
    </div>
    {dialog}
  </main>;
}

function BookingDetail({ booking, onAction }: { booking: Booking; onAction: (action: Action, ticketId?: string, deductionPercentage?: number) => void }) {
  const [showRefundModal, setShowRefundModal] = useState(false);
  const customer = customerOf(booking);
  const { confirm, dialog } = useConfirm();

  const handleRefundOption = async (feePercent: number) => {
    const originalAmount = Number(booking.total_amount);
    const finalAmount = Math.max(0, originalAmount * ((100 - feePercent) / 100));
    const message = feePercent === 0
      ? `Refund ${booking.reference} for exactly R ${finalAmount.toFixed(2)} (full refund)? All valid tickets will be invalidated.`
      : `Apply a ${feePercent}% fee and refund ${booking.reference} for exactly R ${finalAmount.toFixed(2)}? All valid tickets will be invalidated.`;
    const result = await confirm({ title: 'Confirm voucher refund', message, confirmLabel: 'Issue voucher', tone: 'danger' });
    if (result.confirmed) {
      setShowRefundModal(false);
      onAction('refund', undefined, feePercent);
    }
  };

  return <section className="card">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>{booking.reference}</p><h2>Booking details</h2></div>
      <span style={{ padding: '0.35rem 0.65rem', borderRadius: 20, background: booking.voucher_issued ? '#dbeafe' : booking.status === 'PAID' ? '#dcfce7' : '#fef3c7' }}>{booking.voucher_issued ? 'Voucher issued' : booking.status}</span>
    </div>
    <div style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem' }}>
      <p><strong>Customer:</strong> {customer?.first_name} {customer?.last_name}</p>
      <p><strong>Email:</strong> <span style={{ wordBreak: 'break-all' }}>{customer?.email}</span></p>
      <p><strong>Phone:</strong> {customer?.phone}</p>
      <p><strong>Visit date:</strong> {booking.visit_date}</p>
      <p><strong>Total:</strong> R {Number(booking.total_amount).toFixed(2)}</p>
      <p><strong>People:</strong> {booking.people_count}</p>
      <p><strong>Payment:</strong> {booking.payment_method || 'Pending'}</p>
      {booking.refunded_at && <p><strong>Voucher issued:</strong> {new Date(booking.refunded_at).toLocaleString()}</p>}
    </div>
    <h3 style={{ marginTop: '1.5rem' }}>Items</h3>
    {booking.booking_items?.map((item, index) => <p key={index} style={{ borderBottom: '1px solid var(--border-color)', padding: '0.5rem 0', fontSize: '0.9rem' }}>{item.packages?.[0]?.name || item.huts?.[0]?.name || item.metadata?.name || 'Booking item'} × {item.quantity} · R {Number(item.subtotal).toFixed(2)}</p>)}
    <h3 style={{ marginTop: '1.5rem' }}>Tickets</h3>
    {booking.tickets?.length ? booking.tickets.map(ticket => <div key={ticket.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', padding: '0.5rem 0', flexWrap: 'wrap' }}><span style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{ticket.ticket_uid} · <strong>{ticket.status}</strong></span>{ticket.status === 'VALID' && <button className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }} onClick={() => onAction('cancel_ticket', ticket.id)}>Invalidate</button>}</div>) : <p style={{ color: 'var(--text-muted)' }}>No tickets issued.</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: '1.5rem' }}>
      <button className="btn btn-primary" onClick={() => onAction('resend_tickets')}>Resend tickets</button>
      <button className="btn" onClick={() => onAction('mark_paid')} style={{ border: '1px solid var(--border-color)' }}>Mark paid</button>
      {!booking.voucher_issued && <button className="btn" style={{ color: '#b91c1c', border: '1px solid #b91c1c' }} onClick={() => setShowRefundModal(true)}>Voucher refund</button>}
      <button className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={() => onAction('delete')}>Delete</button>
    </div>

    {showRefundModal && (
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowRefundModal(false); }}>
        <div className="modal-card" style={{ maxWidth: 400 }} role="dialog" aria-modal="true">
          <div className="modal-header">
            <h2>Select refund option</h2>
            <button className="modal-close" onClick={() => setShowRefundModal(false)} aria-label="Close">✕</button>
          </div>
          <p className="modal-message">Choose the fee percentage to deduct. The customer will receive a voucher for the remaining balance.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn" onClick={() => handleRefundOption(10)} style={{ border: '1px solid var(--border-color)', justifyContent: 'center' }}>-10% fee</button>
            <button className="btn" onClick={() => handleRefundOption(15)} style={{ border: '1px solid var(--border-color)', justifyContent: 'center' }}>-15% fee</button>
            <button className="btn" onClick={() => handleRefundOption(20)} style={{ border: '1px solid var(--border-color)', justifyContent: 'center' }}>-20% fee</button>
            <button className="btn" onClick={() => handleRefundOption(0)} style={{ border: '1px solid var(--primary)', color: 'var(--primary)', justifyContent: 'center', marginTop: 8 }}>Full refund</button>
          </div>
        </div>
      </div>
    )}
    {dialog}
  </section>;
}
