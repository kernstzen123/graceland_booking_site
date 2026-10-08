'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { johannesburgToday } from '@/lib/opening-rules';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/admin/AdminShell';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import { DownloadIcon } from '@/components/icons';
import { DEFAULT_PRICES, EDITABLE_ITEMS, editableItemPrice, findEditableItem, matchEditableItem, type PriceList } from '@/lib/pricing';
import { seatsNeeded } from '@/lib/booking-edit';
import { spotLabel } from '@/lib/seating';
import { IMPORTED_PAYMENT_METHODS, isImportedPaymentRow, PAYMENT_STATE_LABELS, paymentSummary } from '@/lib/imported-payments';

type Customer = { first_name: string; last_name: string; email: string; phone: string };
type Payment = { id: string; amount: number; method: string; status: string; provider_reference: string | null; created_at: string };
type Booking = { id: string; reference: string; visit_date: string; status: string; payment_method: string | null; total_amount: number; amount_due?: number | null; people_count: number; created_at: string; refunded_at?: string | null; voucher_issued?: boolean; voucher_amount_used?: number | null; deleted_at?: string | null; delete_reason?: string | null; attention_reason?: string | null; attention_at?: string | null; notes?: string | null; customers?: Customer | Customer[]; booking_items?: Array<{ id?: string; quantity: number; price_per_unit?: number; subtotal: number; metadata: { name?: string; itemId?: string; isPerson?: boolean } | null; packages?: Array<{ name: string }>; huts?: Array<{ name: string }> }>; booking_spots?: Array<{ spot_id?: string; venue_spots?: { number: string; type: string } | null }>; tickets?: Array<{ id: string; ticket_uid: string; status: string }>; payments?: Payment[] };
type ListBooking = Pick<Booking, 'id' | 'reference' | 'visit_date' | 'status' | 'payment_method' | 'total_amount' | 'people_count' | 'created_at' | 'voucher_issued' | 'attention_reason' | 'deleted_at'> & { customers?: Partial<Customer> };
type Action = 'resend_tickets' | 'delete' | 'purge' | 'mark_paid' | 'refund' | 'cancel_ticket' | 'resolve_attention';
const isImported = (booking: Booking) => booking.reference.toUpperCase().startsWith('IM-') || booking.payment_method === 'IMPORTED';
/** Notes typed by staff, without the system's markers (IMPORTED_FROM_BOOK, WALK_IN, …). */
const staffNotes = (notes?: string | null) => (notes || '').split('\n').filter(line => !/^[A-Z_]+$/.test(line.trim())).join(' ').trim();
const customerOf = (booking: Booking) => Array.isArray(booking.customers) ? booking.customers[0] : booking.customers;
const STATUS_FILTERS = [{ value: '', label: 'All statuses' }, { value: 'PAID', label: 'Paid' }, { value: 'PENDING', label: 'Awaiting payment' }, { value: 'CANCELLED', label: 'Cancelled / refunded' }, { value: 'FAILED', label: 'Payment failed' }, { value: 'ATTENTION', label: 'Needs attention' }, { value: 'DELETED', label: 'Deleted' }];
const PAID_STATUSES = ['PAID', 'CONFIRMED'];
/**
 * What a voucher refund is based on: the payments actually received (as the
 * database calculates it). An imported booking only counts the payments
 * recorded on it.
 */
const paidAmountOf = (booking: Booking) => {
  const completed = (booking.payments || []).filter(payment => payment.status === 'COMPLETE');
  if (completed.length) return completed.reduce((sum, payment) => sum + Number(payment.amount), 0);
  return booking.payment_method === 'IMPORTED' ? 0 : Number(booking.total_amount);
};
/** The money the customer pays: the total less any voucher used. */
const amountToPayOf = (booking: Booking) => Math.max(0, Number(booking.total_amount) - Number(booking.voucher_amount_used || 0));
const PAYMENT_STATE_COLOURS = { UNPAID: '#fee2e2', PARTIAL: '#fef3c7', PAID: '#dcfce7', OVERPAID: '#dbeafe' } as const;
/** "12 Oct 2026" for a payment. */
const paymentDate = (value: string) => new Date(value).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric' });
type PaymentEntry = { amount: string; method: string; paidOn: string; note: string };

export default function BookingsAdmin() {
  // useSearchParams needs a Suspense boundary so the page can still be prerendered.
  return <Suspense fallback={<main className="container" style={{ padding: '2rem 1rem' }}><div className="card">Loading bookings…</div></main>}><BookingsPage /></Suspense>;
}

function BookingsPage() {
  // ?q= and ?date= come from the menu's "Find booking" search and the dashboard.
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') || '';
  const urlDate = searchParams.get('date') || '';
  const urlStatus = STATUS_FILTERS.some(option => option.value && option.value === searchParams.get('status')) ? searchParams.get('status') || '' : '';
  const [query, setQuery] = useState(urlQuery); const [appliedQuery, setAppliedQuery] = useState(urlQuery); const [searchCount, setSearchCount] = useState(0); const [bookings, setBookings] = useState<ListBooking[]>([]); const [selected, setSelected] = useState<Booking | null>(null); const [message, setMessage] = useState('Loading bookings...');
  const [attentionCount, setAttentionCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState(urlStatus); const [dateFilter, setDateFilter] = useState(urlDate); const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const [pageSize, setPageSize] = useState(50); const [loadingDetail, setLoadingDetail] = useState(''); const [toast, setToast] = useState(''); const [busy, setBusy] = useState(''); const [refundDate, setRefundDate] = useState(johannesburgToday);
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
  // Payments that arrived for bookings that could not be confirmed automatically.
  const loadAttentionCount = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/nav-counts', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      if (response.ok) setAttentionCount(Number((await response.json()).needsAttention || 0));
    } catch { /* the banner is a convenience */ }
  }, []);
  const reload = (nextPage = page) => { loadAttentionCount(); return load({ page: nextPage, search: appliedQuery, status: statusFilter, date: dateFilter }).catch(error => setMessage(error.message)); };
  const openBooking = async (id: string) => {
    setLoadingDetail(id);
    try {
      const response = await fetch(`/api/admin/bookings?id=${id}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) { setMessage(data.error || 'Booking could not be loaded'); return; }
      setSelected(data.booking);
    } finally { setLoadingDetail(''); }
  };
  // Follow the address bar when a search arrives from the menu or dashboard while this page is open.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing filters from the URL
  useEffect(() => { setQuery(urlQuery); setAppliedQuery(urlQuery); setDateFilter(urlDate); if (urlStatus) setStatusFilter(urlStatus); }, [urlQuery, urlDate, urlStatus]);
  // Back to page 1 whenever the search or a filter changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- setState happens after the request
  useEffect(() => { load({ page: 1, search: appliedQuery, status: statusFilter, date: dateFilter }).catch(error => setMessage(error.message)); }, [appliedQuery, statusFilter, dateFilter, searchCount, load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- setState happens after the request
  useEffect(() => { loadAttentionCount(); }, [loadAttentionCount]);
  const showToast = (text: string) => { setToast(text); window.setTimeout(() => setToast(''), 6000); };
  const action = async (type: Action, ticketId?: string, deductionPercentage?: number) => {
    if (!selected || busy) return;
    let reason: string | null = null;
    if (type === 'delete') {
      const result = await confirm({ title: 'Delete booking', message: `Delete booking ${selected.reference}? It will be cancelled and removed from the bookings list. Its payments and history are kept for your records, and you can still find it under the "Deleted" filter.`, confirmLabel: 'Delete booking', tone: 'danger', promptLabel: 'Reason', promptPlaceholder: 'e.g. Duplicate booking, test booking…', promptRequired: true });
      if (!result.confirmed) return;
      reason = result.value;
    } else if (type === 'purge') {
      const result = await confirm({ title: 'Permanently delete booking', message: `Permanently delete ${selected.reference}? The booking, its items, tickets, meal vouchers, payments and proofs are erased for good and cannot be recovered. It will no longer count in reports or revenue.`, confirmLabel: 'Delete permanently', tone: 'danger', promptLabel: 'Reason', promptPlaceholder: 'e.g. Test booking, duplicate entry…', promptRequired: true });
      if (!result.confirmed) return;
      reason = result.value;
    } else if (type === 'mark_paid') {
      const result = await confirm({ title: 'Mark booking as paid', message: `Mark booking ${selected.reference} as paid and issue tickets? Only do this once the money has been received.`, confirmLabel: 'Mark as paid', tone: 'primary', promptLabel: 'How was it paid?', promptPlaceholder: 'e.g. Cash at the office on 3 Oct, receipt 1042', promptRequired: true });
      if (!result.confirmed) return;
      reason = result.value;
    } else if (type === 'resolve_attention') {
      const result = await confirm({ title: 'Resolve alert', message: 'Mark this alert as resolved? Describe what was done so it is recorded in the audit log.', confirmLabel: 'Mark resolved', tone: 'primary', promptLabel: 'What was done?', promptPlaceholder: 'e.g. Refunded R 450 in PayFast on 3 Oct', promptRequired: true });
      if (!result.confirmed) return;
      reason = result.value;
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
      let response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body });
      let data = await response.json();
      // The reservation lapsed and the day is full or the seat was taken: an admin may accept that.
      if (type === 'mark_paid' && response.status === 409 && data.canForce) {
        const forceResult = await confirm({ title: 'Booking can no longer be confirmed', message: `${data.error} Mark it paid anyway? The day will go over capacity or two groups will share a spot.`, confirmLabel: 'Mark paid anyway', tone: 'danger' });
        if (!forceResult.confirmed) { setMessage(data.error); return; }
        response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: selected.id, action: type, reason, force: true }) });
        data = await response.json();
      }
      setMessage(data.message || data.error); if (!response.ok) return;
      if (type === 'delete' || type === 'purge') setSelected(null); else await openBooking(selected.id);
      if (type === 'resolve_attention') showToast('Alert resolved');
      await reload();
      if (type === 'resend_tickets') showToast('Tickets resent successfully');
      if (type === 'refund') showToast(data.emailSent ? 'Voucher issued and email sent' : 'Voucher issued; email queued for retry');
    } finally { setBusy(''); }
  };
  /** Record a payment on an imported booking. Returns an error message, or '' when saved. */
  const recordPayment = async (entry: PaymentEntry) => {
    if (!selected || busy) return 'Please wait…';
    setBusy('add_payment');
    try {
      const send = async (allowOverpayment: boolean) => fetch('/api/admin/bookings', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: selected.id, action: 'add_payment', payment: { ...entry, amount: Number(entry.amount) }, allowOverpayment }) });
      let response = await send(false);
      let data = await response.json();
      if (response.status === 409 && data.overpayment) {
        const result = await confirm({ title: 'More than is owed', message: `${data.error} Record R ${Number(entry.amount).toFixed(2)} anyway? The booking will show as overpaid.`, confirmLabel: 'Record anyway', tone: 'danger' });
        if (!result.confirmed) return data.error;
        response = await send(true);
        data = await response.json();
      }
      if (!response.ok) return data.error || 'The payment could not be recorded.';
      setMessage(data.message || ''); showToast('Payment recorded');
      await openBooking(selected.id);
      return '';
    } finally { setBusy(''); }
  };
  const removePayment = async (paymentId: string, label: string) => {
    if (!selected || busy) return;
    const result = await confirm({ title: 'Remove payment', message: `Remove the ${label} payment? The booking's outstanding balance goes up by that amount. The payment stays in the history marked VOID.`, confirmLabel: 'Remove payment', tone: 'danger', promptLabel: 'Reason', promptPlaceholder: 'e.g. Entered twice, wrong amount…', promptRequired: true });
    if (!result.confirmed) return;
    setBusy('void_payment');
    try {
      const response = await fetch('/api/admin/bookings', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: selected.id, action: 'void_payment', paymentId, reason: result.value }) });
      const data = await response.json();
      setMessage(data.message || data.error);
      if (response.ok) { showToast('Payment removed'); await openBooking(selected.id); }
    } finally { setBusy(''); }
  };
  /** Save edits to an imported booking. Returns an error message, or '' when saved. */
  const saveEdit = async (edit: Record<string, unknown>) => {
    if (!selected || busy) return 'Please wait…';
    setBusy('update');
    try {
      const response = await fetch('/api/admin/bookings', { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: selected.id, action: 'update', edit }) });
      const data = await response.json();
      if (!response.ok) return data.error || 'The booking could not be saved.';
      setMessage(data.message || ''); showToast(data.message || 'Booking updated');
      await openBooking(selected.id); await reload();
      return '';
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
    <PageHeader eyebrow="Bookings" title="All bookings" description="Search, filter and manage every booking." actions={<button className="btn btn-primary" onClick={() => { setExportMode('all'); setExportFrom(''); setExportTo(''); setShowExport(true); }} style={{ gap: 6 }}><DownloadIcon size={15} /> Export to Excel</button>} />
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
      <form onSubmit={event => { event.preventDefault(); setAppliedQuery(query.trim()); setSearchCount(count => count + 1); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ref, ticket, name, or email" style={{ flex: '1 1 200px', padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
        <select aria-label="Status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)} style={{ padding: '0.8rem', border: '1px solid var(--border-color)', borderRadius: 8 }}>{STATUS_FILTERS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input aria-label="Visit date" type="date" value={dateFilter} onChange={event => setDateFilter(event.target.value)} style={{ padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: 8 }} />
        {dateFilter && <button type="button" className="btn" onClick={() => setDateFilter('')} style={{ border: '1px solid var(--border-color)' }}>Any date</button>}
        <button className="btn btn-primary">Search</button>
      </form>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}><label style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>Refund all for <input type="date" value={refundDate} onChange={event => setRefundDate(event.target.value)} style={{ padding: 8, marginLeft: 4 }} /></label><button className="btn" onClick={refundAll} style={{ color: '#b91c1c', border: '1px solid #b91c1c' }}>Refund all for date</button></div>
    </div>
    {attentionCount > 0 && statusFilter !== 'ATTENTION' && <div className="callout callout-danger" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <p style={{ margin: 0, flex: '1 1 260px' }}><strong>{attentionCount} booking{attentionCount === 1 ? ' needs' : 's need'} attention.</strong> Money was received for {attentionCount === 1 ? 'a booking that' : 'bookings that'} could not be confirmed automatically.</p>
      <button type="button" className="btn btn-danger" onClick={() => { setStatusFilter('ATTENTION'); setSelected(null); }}>Show {attentionCount === 1 ? 'it' : 'them'}</button>
    </div>}
    {message && <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{message}</p>}
    <div className={`admin-panels${selected ? ' has-detail' : ''}`}>
      <div style={{ display: 'grid', gap: '0.75rem', alignContent: 'start' }}>
        {total > 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} bookings</p>}
        {bookings.map(booking => <button key={booking.id} onClick={() => openBooking(booking.id)} aria-busy={loadingDetail === booking.id} style={{ textAlign: 'left', background: selected?.id === booking.id ? '#e0f2fe' : 'white', border: '1px solid var(--border-color)', borderRadius: 10, padding: '1rem', opacity: loadingDetail === booking.id ? 0.6 : 1 }}><strong style={{ color: 'var(--primary)' }}>{booking.reference}</strong><p>{booking.customers?.first_name} {booking.customers?.last_name}</p><p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{booking.visit_date} · R {Number(booking.total_amount).toFixed(2)} · {booking.voucher_issued ? 'Voucher issued' : booking.status}</p>{(booking.attention_reason || booking.deleted_at) && <p style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>{booking.attention_reason && <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: 999, background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>Needs attention</span>}{booking.deleted_at && <span style={{ fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: 999, background: '#e2e8f0', color: '#475569' }}>Deleted</span>}</p>}</button>)}
        {total > pageSize && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button className="btn" disabled={page <= 1} onClick={() => reload(page - 1)} style={{ border: '1px solid var(--border-color)' }}>← Newer</button>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Page {page} of {Math.ceil(total / pageSize)}</span>
          <button className="btn" disabled={page * pageSize >= total} onClick={() => reload(page + 1)} style={{ border: '1px solid var(--border-color)' }}>Older →</button>
        </div>}
      </div>
      {selected && <BookingDetail booking={selected} onAction={action} onSaveEdit={saveEdit} onRecordPayment={recordPayment} onRemovePayment={removePayment} />}
    </div>
    {dialog}
  </main>;
}

/** An item line in the edit form: a price-list item, or (itemId null) an old hand-typed line kept as it was. */
type EditItem = { id?: string; itemId: string | null; legacyName?: string; legacyPerson?: boolean; quantity: string; price: string };
type SeatOption = { id: string; number: string; type: string; capacity: number; takenBy: string | null };

/** The price list grouped for the item dropdowns. */
const ITEM_GROUPS = [...new Set(EDITABLE_ITEMS.map(item => item.group))].map(group => ({ group, items: EDITABLE_ITEMS.filter(item => item.group === group) }));

function BookingDetail({ booking, onAction, onSaveEdit, onRecordPayment, onRemovePayment }: { booking: Booking; onAction: (action: Action, ticketId?: string, deductionPercentage?: number) => void; onSaveEdit: (edit: Record<string, unknown>) => Promise<string>; onRecordPayment: (entry: PaymentEntry) => Promise<string>; onRemovePayment: (paymentId: string, label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', visit_date: '', notes: '', total: '', people: '' });
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [prices, setPrices] = useState<PriceList>(DEFAULT_PRICES);
  const [seatIds, setSeatIds] = useState<string[]>([]);
  const [seatOptions, setSeatOptions] = useState<SeatOption[]>([]);
  const [seatError, setSeatError] = useState('');
  const isPersonLine = (item: EditItem) => (item.itemId ? findEditableItem(item.itemId)?.isPerson === true : item.legacyPerson === true);
  const itemsTotal = editItems.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
  const itemsPeople = editItems.reduce((sum, item) => sum + (isPersonLine(item) ? Number(item.quantity) || 0 : 0), 0);
  const need = seatsNeeded(editItems.map(item => ({ item: findEditableItem(item.itemId), quantity: Number(item.quantity) || 0 })));
  const currentSeats = (booking.booking_spots || []).filter(bs => bs.spot_id && bs.venue_spots).map(bs => ({ id: bs.spot_id as string, label: spotLabel(bs.venue_spots!.type, bs.venue_spots!.number), type: bs.venue_spots!.type }));
  const seatType = (id: string) => seatOptions.find(option => option.id === id)?.type || currentSeats.find(seat => seat.id === id)?.type;
  const chosenHuts = seatIds.filter(id => seatType(id) === 'hut').length;
  const chosenTables = seatIds.filter(id => seatType(id) === 'table').length;
  const seatsMatch = chosenHuts === need.huts && chosenTables === need.tables;

  /** Huts and tables on the map for a date, marking those another booking holds. */
  const loadSeats = async (date: string) => {
    setSeatError('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    try {
      const accessToken = (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
      const response = await fetch(`/api/admin/bookings/${booking.id}/seating?date=${date}`, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the seating.');
      setSeatOptions(data.spots);
    } catch (loadError) { setSeatError(loadError instanceof Error ? loadError.message : 'Could not load the seating.'); }
  };
  const startEditing = () => {
    const current = customerOf(booking);
    setForm({ first_name: current?.first_name || '', last_name: current?.last_name || '', email: current?.email || '', phone: current?.phone || '', visit_date: booking.visit_date, notes: staffNotes(booking.notes), total: String(Number(booking.total_amount)), people: String(booking.people_count) });
    setEditItems((booking.booking_items || []).map(item => {
      const match = matchEditableItem(item.metadata);
      return { id: item.id, itemId: match?.id || null, legacyName: match ? undefined : item.metadata?.name || 'Booking item', legacyPerson: item.metadata?.isPerson === true, quantity: String(item.quantity), price: String(Number(item.price_per_unit ?? 0)) };
    }));
    setSeatIds(currentSeats.map(seat => seat.id));
    setEditError(''); setEditing(true);
    loadSeats(booking.visit_date);
    fetch('/api/prices', { cache: 'no-store' }).then(response => (response.ok ? response.json() : null)).then(data => { if (data?.prices) setPrices(data.prices); }).catch(() => { /* default prices stay */ });
  };
  const chooseItem = (index: number, itemId: string) => {
    const item = findEditableItem(itemId);
    setEditItems(editItems.map((row, i) => (i === index ? { ...row, itemId: item ? item.id : null, price: item ? String(editableItemPrice(item, prices)) : row.price } : row)));
  };
  const saveEditForm = async () => {
    if (editItems.some(item => !item.itemId && !item.id)) { setEditError('Choose an item from the list for every line.'); return; }
    setSaving(true); setEditError('');
    const error = await onSaveEdit({
      customer: { first_name: form.first_name, last_name: form.last_name, email: form.email, phone: form.phone },
      visit_date: form.visit_date, notes: form.notes, total_amount: form.total, people_count: form.people,
      spot_ids: seatIds.filter(Boolean),
      items: editItems.map(item => ({ id: item.id, itemId: item.itemId, quantity: Number(item.quantity), price_per_unit: Number(item.price) })),
    });
    setSaving(false);
    if (error) setEditError(error); else setEditing(false);
  };
  const inputStyle = { padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: 8, width: '100%' } as const;
  const labelStyle = { display: 'grid', gap: 4, fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' } as const;
  const [showRefundModal, setShowRefundModal] = useState(false);
  const customer = customerOf(booking);
  const { confirm, dialog } = useConfirm();
  const isPaid = PAID_STATUSES.includes(booking.status);
  const isDeleted = Boolean(booking.deleted_at);
  const isCancelled = ['CANCELLED', 'REFUNDED'].includes(booking.status);
  const paidAmount = paidAmountOf(booking);
  const voucherFor = (feePercent: number) => Math.round(paidAmount * (100 - feePercent)) / 100;
  const spots = (booking.booking_spots || []).map(bs => bs.venue_spots).filter(Boolean);

  const handleRefundOption = async (feePercent: number) => {
    const finalAmount = voucherFor(feePercent);
    const message = feePercent === 0
      ? `Refund ${booking.reference} for exactly R ${finalAmount.toFixed(2)} (full refund)? All valid tickets will be invalidated.`
      : `Apply a ${feePercent}% fee to the R ${paidAmount.toFixed(2)} paid and refund ${booking.reference} for exactly R ${finalAmount.toFixed(2)}? All valid tickets will be invalidated.`;
    const result = await confirm({ title: 'Confirm voucher refund', message, confirmLabel: 'Issue voucher', tone: 'danger' });
    if (result.confirmed) {
      setShowRefundModal(false);
      onAction('refund', undefined, feePercent);
    }
  };

  return <section className="card">
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>{booking.reference}</p><h2>Booking details</h2></div>
      <span style={{ padding: '0.35rem 0.65rem', borderRadius: 20, background: isDeleted ? '#e2e8f0' : booking.voucher_issued ? '#dbeafe' : booking.status === 'PAID' ? '#dcfce7' : '#fef3c7' }}>{isDeleted ? 'Deleted' : booking.voucher_issued ? 'Voucher issued' : booking.status}</span>
    </div>
    {booking.attention_reason && <div className="callout callout-danger" role="alert">
      <p><strong>Needs attention{booking.attention_at ? ` · ${new Date(booking.attention_at).toLocaleString()}` : ''}</strong></p>
      <p style={{ whiteSpace: 'pre-line' }}>{booking.attention_reason}</p>
      <button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={() => onAction('resolve_attention')}>Mark as resolved</button>
    </div>}
    {booking.payment_method === 'IMPORTED' && <div className="callout callout-info">
      <p><strong>Imported from the booking book</strong></p>
      <p>No QR tickets were sent. At the gate, find the guests by name, phone or email in the scanner search and check them in. Record each payment or deposit under Balance below so the amount owed stays correct.</p>
    </div>}
    {staffNotes(booking.notes) && <p style={{ marginTop: '0.75rem' }}><strong>Notes:</strong> {staffNotes(booking.notes)}</p>}
    {isDeleted && <div className="callout callout-warning">
      <p><strong>Deleted {new Date(booking.deleted_at as string).toLocaleString()}</strong></p>
      {booking.delete_reason && <p>Reason: {booking.delete_reason}</p>}
    </div>}
    <div style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem' }}>
      <p><strong>Customer:</strong> {customer?.first_name} {customer?.last_name}</p>
      <p><strong>Email:</strong> <span style={{ wordBreak: 'break-all' }}>{customer?.email}</span></p>
      <p><strong>Phone:</strong> {customer?.phone}</p>
      <p><strong>Visit date:</strong> {booking.visit_date}</p>
      <p><strong>Total:</strong> R {Number(booking.total_amount).toFixed(2)}</p>
      <p><strong>People:</strong> {booking.people_count}</p>
      {spots.length > 0 && <p><strong>Seating:</strong> {spots.map(s => `${s?.type === 'hut' ? 'Hut' : 'Table'} ${s?.number}`).join(', ')}</p>}
      <p><strong>Payment:</strong> {booking.payment_method || 'Pending'}</p>
      {booking.refunded_at && <p><strong>Voucher issued:</strong> {new Date(booking.refunded_at).toLocaleString()}</p>}
    </div>
    <h3 style={{ marginTop: '1.5rem' }}>Items</h3>
    {booking.booking_items?.map((item, index) => <p key={index} style={{ borderBottom: '1px solid var(--border-color)', padding: '0.5rem 0', fontSize: '0.9rem' }}>{item.packages?.[0]?.name || item.huts?.[0]?.name || item.metadata?.name || 'Booking item'} × {item.quantity} · R {Number(item.subtotal).toFixed(2)}</p>)}
    <BalanceSection booking={booking} canRecord={isImported(booking) && isPaid && !isDeleted && !booking.voucher_issued} onRecordPayment={onRecordPayment} />
    <h3 style={{ marginTop: '1.5rem' }}>Payments</h3>
    {booking.payments?.length ? booking.payments.map(payment => {
      const recordedByHand = isImportedPaymentRow(payment);
      const method = recordedByHand ? IMPORTED_PAYMENT_METHODS[payment.method] || payment.method : payment.method;
      const note = recordedByHand ? (payment.provider_reference || '').replace(/^IMPORTED( · )?/, '') : payment.provider_reference;
      return <div key={payment.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)', padding: '0.5rem 0', fontSize: '0.9rem' }}>
        <p style={{ textDecoration: payment.status === 'VOID' ? 'line-through' : undefined }}>R {Number(payment.amount).toFixed(2)} · {method} · <strong>{payment.status === 'VOID' ? 'REMOVED' : payment.status}</strong>{note ? <> · <span style={{ wordBreak: 'break-all' }}>{note}</span></> : null}<br /><small style={{ color: 'var(--text-muted)' }}>{recordedByHand ? `Paid ${paymentDate(payment.created_at)}` : new Date(payment.created_at).toLocaleString()}</small></p>
        {recordedByHand && payment.status === 'COMPLETE' && isPaid && !isDeleted && !booking.voucher_issued && <button type="button" className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }} onClick={() => onRemovePayment(payment.id, `R ${Number(payment.amount).toFixed(2)} ${method.toLowerCase()}`)}>Remove</button>}
      </div>;
    }) : <p style={{ color: 'var(--text-muted)' }}>No payments recorded.</p>}
    <h3 style={{ marginTop: '1.5rem' }}>Tickets</h3>
    {booking.tickets?.length ? booking.tickets.map(ticket => <div key={ticket.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-color)', padding: '0.5rem 0', flexWrap: 'wrap' }}><span style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{ticket.ticket_uid} · <strong>{ticket.status}</strong></span>{ticket.status === 'VALID' && <button className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }} onClick={() => onAction('cancel_ticket', ticket.id)}>Invalidate</button>}</div>) : <p style={{ color: 'var(--text-muted)' }}>No tickets issued.</p>}
    {!isDeleted && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: '1.5rem' }}>
      {isImported(booking) && <button className="btn btn-primary" onClick={startEditing}>Edit booking</button>}
      {isPaid && <button className="btn btn-primary" onClick={() => onAction('resend_tickets')}>Resend tickets</button>}
      {!isPaid && !isCancelled && <button className="btn" onClick={() => onAction('mark_paid')} style={{ border: '1px solid var(--border-color)' }}>Mark paid</button>}
      {isPaid && !booking.voucher_issued && <button className="btn" style={{ color: '#b91c1c', border: '1px solid #b91c1c' }} onClick={() => setShowRefundModal(true)}>Voucher refund</button>}
      {!isPaid && booking.status !== 'PAYMENT_PENDING' && <button className="btn" style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }} onClick={() => onAction('delete')}>Delete</button>}
    </div>}
    <div style={{ marginTop: '0.75rem' }}><button className="btn" style={{ background: '#b91c1c', color: 'white' }} onClick={() => onAction('purge')}>Delete permanently</button></div>
    {editing && (
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) setEditing(false); }}>
        <div className="modal-card" style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }} role="dialog" aria-modal="true">
          <div className="modal-header"><h2>Edit {booking.reference}</h2><button className="modal-close" onClick={() => setEditing(false)} aria-label="Close">✕</button></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={labelStyle}>First name<input style={inputStyle} value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} /></label>
            <label style={labelStyle}>Surname<input style={inputStyle} value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} /></label>
            <label style={labelStyle}>Email<input style={inputStyle} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
            <label style={labelStyle}>Phone<input style={inputStyle} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
            <label style={labelStyle}>Visit date<input style={inputStyle} type="date" value={form.visit_date} onChange={e => { setForm({ ...form, visit_date: e.target.value }); loadSeats(e.target.value); }} /></label>
            <label style={labelStyle}>People (headcount)<input style={inputStyle} type="number" min={1} value={form.people} onChange={e => setForm({ ...form, people: e.target.value })} /></label>
          </div>
          <h3 style={{ margin: '1rem 0 0.5rem' }}>Items</h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {editItems.map((item, index) => (
              <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 64px 92px auto', gap: 6, alignItems: 'end' }}>
                <label style={labelStyle}>Item
                  <select style={{ ...inputStyle, borderColor: item.itemId ? 'var(--border-color)' : 'var(--warning)' }} value={item.itemId || ''} onChange={e => chooseItem(index, e.target.value)}>
                    {!item.itemId && <option value="">{item.legacyName ? `⚠ Not on the price list: ${item.legacyName}` : 'Choose an item…'}</option>}
                    {ITEM_GROUPS.map(({ group, items }) => <optgroup key={group} label={group}>{items.map(option => <option key={option.id} value={option.id}>{option.name}{option.isPerson ? '' : ' (no gate ticket)'}</option>)}</optgroup>)}
                  </select>
                </label>
                <label style={labelStyle}>Qty<input style={inputStyle} type="number" min={1} value={item.quantity} onChange={e => setEditItems(editItems.map((row, i) => i === index ? { ...row, quantity: e.target.value } : row))} /></label>
                <label style={labelStyle}>Price each<input style={inputStyle} type="number" min={0} step="0.01" value={item.price} onChange={e => setEditItems(editItems.map((row, i) => i === index ? { ...row, price: e.target.value } : row))} /></label>
                <button type="button" className="btn" aria-label="Remove item" disabled={editItems.length <= 1} onClick={() => setEditItems(editItems.filter((_, i) => i !== index))} style={{ color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0.5rem 0.6rem' }}>✕</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn" onClick={() => setEditItems([...editItems, { itemId: null, quantity: '1', price: '0' }])} style={{ marginTop: 8, border: '1px solid var(--border-color)' }}>+ Add item</button>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 8 }}>Choosing an item fills in today&apos;s price; change it if the booking book shows a different price. Every entrance ticket gets a gate ticket; saving rebuilds unscanned tickets to match.</p>
          {editItems.some(item => !item.itemId && item.legacyName) && <p style={{ color: 'var(--warning-text)', fontSize: '0.8rem', marginTop: 4 }}>Lines marked ⚠ were typed in by hand and are not counted in reports or the daily summary. Choose the matching item from the list.</p>}

          <h3 style={{ margin: '1rem 0 0.25rem' }}>Seating</h3>
          <p style={{ color: seatsMatch ? 'var(--text-muted)' : 'var(--warning-text)', fontSize: '0.8rem', marginBottom: 6 }}>
            The items need {need.huts} hut{need.huts === 1 ? '' : 's'} and {need.tables} table{need.tables === 1 ? '' : 's'}{editItems.some(item => item.itemId?.startsWith('party-children-')) ? ' (a party includes one hut)' : ''}; {chosenHuts} hut{chosenHuts === 1 ? '' : 's'} and {chosenTables} table{chosenTables === 1 ? '' : 's'} chosen.
          </p>
          {seatError && <p role="alert" style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{seatError}</p>}
          <div style={{ display: 'grid', gap: 6 }}>
            {seatIds.map((seatId, index) => {
              const offMap = seatId && !seatOptions.some(option => option.id === seatId) ? currentSeats.find(seat => seat.id === seatId) : null;
              return <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6 }}>
                <select aria-label={`Seat ${index + 1}`} style={inputStyle} value={seatId} onChange={e => setSeatIds(seatIds.map((id, i) => (i === index ? e.target.value : id)))}>
                  <option value="">Choose a hut or table…</option>
                  {offMap && <option value={offMap.id}>{offMap.label} (previous map)</option>}
                  {(['hut', 'table'] as const).map(type => <optgroup key={type} label={type === 'hut' ? 'Covered huts' : 'Shaded tables'}>
                    {seatOptions.filter(option => option.type === type).map(option => {
                      const chosenElsewhere = seatIds.some((id, i) => id === option.id && i !== index);
                      return <option key={option.id} value={option.id} disabled={Boolean(option.takenBy) || chosenElsewhere}>{spotLabel(option.type, option.number)} · seats {option.capacity}{option.takenBy ? ` · taken (${option.takenBy})` : chosenElsewhere ? ' · already chosen' : ''}</option>;
                    })}
                  </optgroup>)}
                </select>
                <button type="button" className="btn" aria-label="Remove seat" onClick={() => setSeatIds(seatIds.filter((_, i) => i !== index))} style={{ color: 'var(--danger)', border: '1px solid var(--danger)', padding: '0.5rem 0.6rem' }}>✕</button>
              </div>;
            })}
          </div>
          <button type="button" className="btn" onClick={() => setSeatIds([...seatIds, ''])} style={{ marginTop: 8, border: '1px solid var(--border-color)' }}>+ Add hut or table</button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end', marginTop: 10 }}>
            <label style={labelStyle}>Total (R)<input style={inputStyle} type="number" min={0} step="0.01" value={form.total} onChange={e => setForm({ ...form, total: e.target.value })} /></label>
            <button type="button" className="btn" onClick={() => setForm({ ...form, total: itemsTotal.toFixed(2), people: String(itemsPeople || form.people) })} style={{ border: '1px solid var(--border-color)' }}>Use items: R {itemsTotal.toFixed(2)} · {itemsPeople} people</button>
          </div>
          <label style={{ ...labelStyle, marginTop: 10 }}>Notes<textarea style={{ ...inputStyle, minHeight: 70 }} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
          {editError && <p role="alert" style={{ color: 'var(--danger)', marginTop: 10 }}>{editError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn" style={{ flex: 1, border: '1px solid var(--border-color)' }} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 2 }} disabled={saving} onClick={saveEditForm}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      </div>
    )}
    {!isDeleted && booking.status === 'PAYMENT_PENDING' && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.75rem' }}>A proof of payment is waiting for review on the Proofs of payment page.</p>}

    {showRefundModal && (
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowRefundModal(false); }}>
        <div className="modal-card" style={{ maxWidth: 400 }} role="dialog" aria-modal="true">
          <div className="modal-header">
            <h2>Select refund option</h2>
            <button className="modal-close" onClick={() => setShowRefundModal(false)} aria-label="Close">✕</button>
          </div>
          <p className="modal-message">The customer paid R {paidAmount.toFixed(2)}. Choose the cancellation fee to deduct; they receive a voucher for the rest.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[10, 15, 20].map(fee => <button key={fee} className="btn" onClick={() => handleRefundOption(fee)} style={{ border: '1px solid var(--border-color)', justifyContent: 'center' }}>-{fee}% fee · voucher R {voucherFor(fee).toFixed(2)}</button>)}
            <button className="btn" onClick={() => handleRefundOption(0)} style={{ border: '1px solid var(--primary)', color: 'var(--primary)', justifyContent: 'center', marginTop: 8 }}>Full refund · voucher R {paidAmount.toFixed(2)}</button>
          </div>
        </div>
      </div>
    )}
    {dialog}
  </section>;
}

/** Total, paid and outstanding for a booking; on an imported booking, a form to record a payment. */
function BalanceSection({ booking, canRecord, onRecordPayment }: { booking: Booking; canRecord: boolean; onRecordPayment: (entry: PaymentEntry) => Promise<string> }) {
  const [adding, setAdding] = useState(false);
  const [entry, setEntry] = useState<PaymentEntry>({ amount: '', method: 'CASH', paidOn: johannesburgToday(), note: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const cancelled = ['CANCELLED', 'REFUNDED'].includes(booking.status) || Boolean(booking.voucher_issued) || Boolean(booking.deleted_at);
  const summary = paymentSummary(amountToPayOf(booking), booking.payments || []);
  const voucher = Number(booking.voucher_amount_used || 0);
  const inputStyle = { width: '100%', padding: '0.55rem', border: '1px solid var(--border-color)', borderRadius: 8, font: 'inherit' };
  const save = async () => {
    setSaving(true); setError('');
    const problem = await onRecordPayment(entry);
    setSaving(false);
    if (problem) { setError(problem); return; }
    setAdding(false); setEntry({ amount: '', method: 'CASH', paidOn: johannesburgToday(), note: '' });
  };
  // Online bookings that were never paid simply show what they cost.
  if (!PAID_STATUSES.includes(booking.status) && !cancelled) return null;

  return <div style={{ marginTop: '1.5rem' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <h3>Balance</h3>
      {!cancelled && <span style={{ padding: '0.25rem 0.6rem', borderRadius: 20, fontSize: '0.85rem', fontWeight: 600, background: PAYMENT_STATE_COLOURS[summary.state] }}>{PAYMENT_STATE_LABELS[summary.state]}</span>}
    </div>
    {cancelled ? <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>This booking is cancelled, so nothing is owed.</p> : <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.5rem', marginTop: '0.75rem' }}>
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.6rem 0.75rem' }}><small style={{ color: 'var(--text-muted)' }}>{voucher > 0 ? 'To pay (after voucher)' : 'Booking total'}</small><p style={{ fontWeight: 700 }}>R {summary.total.toFixed(2)}</p></div>
        <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.6rem 0.75rem' }}><small style={{ color: 'var(--text-muted)' }}>Paid</small><p style={{ fontWeight: 700 }}>R {summary.paid.toFixed(2)}</p></div>
        <div style={{ border: `1px solid ${summary.outstanding > 0 ? 'var(--danger)' : 'var(--border-color)'}`, borderRadius: 8, padding: '0.6rem 0.75rem' }}><small style={{ color: 'var(--text-muted)' }}>{summary.overpaid > 0 ? 'Overpaid' : 'Outstanding'}</small><p style={{ fontWeight: 700, color: summary.outstanding > 0 ? 'var(--danger)' : undefined }}>R {(summary.overpaid > 0 ? summary.overpaid : summary.outstanding).toFixed(2)}</p></div>
      </div>
      {voucher > 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.4rem' }}>R {voucher.toFixed(2)} of the R {Number(booking.total_amount).toFixed(2)} total was paid with a voucher.</p>}
      {canRecord && !adding && <button type="button" className="btn btn-secondary" style={{ marginTop: '0.75rem' }} onClick={() => { setAdding(true); setError(''); }}>Record a payment</button>}
      {canRecord && adding && <div style={{ marginTop: '0.75rem', border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.75rem', display: 'grid', gap: '0.6rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.6rem' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Amount (R)<input style={inputStyle} type="number" min={0.01} step="0.01" inputMode="decimal" value={entry.amount} onChange={e => setEntry({ ...entry, amount: e.target.value })} autoFocus /></label>
          <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Paid by<select style={inputStyle} value={entry.method} onChange={e => setEntry({ ...entry, method: e.target.value })}>{Object.entries(IMPORTED_PAYMENT_METHODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Date paid<input style={inputStyle} type="date" max={johannesburgToday()} value={entry.paidOn} onChange={e => setEntry({ ...entry, paidOn: e.target.value })} /></label>
        </div>
        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Note (optional)<input style={inputStyle} maxLength={120} placeholder="e.g. Deposit, receipt 1042" value={entry.note} onChange={e => setEntry({ ...entry, note: e.target.value })} /></label>
        {summary.outstanding > 0 && <button type="button" className="btn" style={{ border: '1px solid var(--border-color)', justifySelf: 'start' }} onClick={() => setEntry({ ...entry, amount: summary.outstanding.toFixed(2) })}>Pays the rest: R {summary.outstanding.toFixed(2)}</button>}
        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" disabled={saving || !(Number(entry.amount) > 0)} onClick={save}>{saving ? 'Saving…' : 'Save payment'}</button>
          <button type="button" className="btn" style={{ border: '1px solid var(--border-color)' }} disabled={saving} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      </div>}
    </>}
  </div>;
}
