'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import { buildPackageGroups, DEFAULT_PRICES, type PriceList } from '@/lib/pricing';
import { GATE_PAYMENT_METHODS, type GatePaymentKey, type WalkInReceipt } from '@/lib/walk-ins';

type Spot = { id: string; number: string; type: 'hut' | 'table'; capacity: number; available: boolean; unavailableReason?: string };
type Sale = { bookingId: string; reference: string; createdAt: string; status: string; paymentMethod: string; total: number; people: number; soldBy: string; customerName: string; items: string; ticketsScanned: number; tickets: number };
type CashUp = { date: string; ownSalesOnly: boolean; totals: { sales: number; amount: number; people: number; cancelled: number }; byMethod: Array<{ method: string; sales: number; amount: number }>; byStaff: Array<{ name: string; sales: number; amount: number; cash: number; people: number }>; sales: Sale[] };

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const rand = (value: number) => `R ${value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const fieldStyle = { padding: '0.65rem', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: '1rem', width: '100%' } as const;

function Receipt({ receipt, onNewSale }: { receipt: WalkInReceipt; onNewSale?: () => void }) {
  const [qrCodes, setQrCodes] = useState<Record<string, string>>({});
  const needsTickets = !receipt.checkedIn;
  useEffect(() => {
    if (!needsTickets) return;
    let cancelled = false;
    Promise.all(receipt.tickets.filter(t => t.status === 'VALID').map(async ticket => [ticket.ticketUid, await QRCode.toDataURL(`${window.location.origin}/admin/scanner?token=${encodeURIComponent(ticket.qrToken)}`, { margin: 1, width: 180 })] as const))
      .then(entries => { if (!cancelled) setQrCodes(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [receipt, needsTickets]);

  return <div className="card walkin-receipt print-area">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <p style={{ color: 'var(--success-text)', fontWeight: 700 }} className="no-print">✓ Sale complete</p>
        <h2 style={{ margin: '0.25rem 0' }}>Graceland Venues</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{receipt.reference} · {new Date(receipt.createdAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })}</p>
        {receipt.customerName && <p style={{ fontSize: '0.9rem' }}>{receipt.customerName}</p>}
      </div>
      <div className="no-print" style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ border: '1px solid var(--border-color)' }} onClick={() => window.print()}>Print</button>
        {onNewSale && <button className="btn btn-primary" onClick={onNewSale}>New sale</button>}
      </div>
    </div>
    <table className="report-table" style={{ margin: '1rem 0' }}>
      <tbody>
        {receipt.lines.map((line, i) => <tr key={i}><td style={{ whiteSpace: 'normal' }}>{line.quantity}× {line.name}</td><td style={{ textAlign: 'right' }}>{rand(line.subtotal)}</td></tr>)}
        <tr><td><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{rand(receipt.total)}</strong></td></tr>
        <tr><td>Paid by</td><td style={{ textAlign: 'right' }}>{receipt.paymentMethod.replace('Walk-in: ', '')}{receipt.paymentReference ? ` (${receipt.paymentReference})` : ''}</td></tr>
        {receipt.amountTendered !== null && <tr><td>Cash received</td><td style={{ textAlign: 'right' }}>{rand(receipt.amountTendered)}</td></tr>}
        {receipt.change !== null && <tr><td><strong>Change</strong></td><td style={{ textAlign: 'right' }}><strong>{rand(receipt.change)}</strong></td></tr>}
      </tbody>
    </table>
    {receipt.change !== null && receipt.change > 0 && <div className="callout callout-warning no-print" style={{ marginBottom: '1rem' }}><p style={{ fontSize: '1.25rem' }}>Give change: <strong>{rand(receipt.change)}</strong></p></div>}
    <p style={{ fontSize: '0.9rem' }}>{receipt.people} {receipt.people === 1 ? 'person' : 'people'}{receipt.seating.length ? ` · Seating: ${receipt.seating.join(', ')}` : ''}</p>
    <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
      {receipt.checkedIn ? 'All tickets checked in at the gate.' : `${receipt.tickets.length} ticket${receipt.tickets.length === 1 ? '' : 's'} issued — scan at the gate to enter.`}
      {receipt.emailSent === true && ' Tickets emailed to the customer.'}
      {receipt.emailSent === false && ' The ticket email could not be sent; it will be retried from Email retries.'}
      {receipt.soldBy && ` Sold by ${receipt.soldBy}.`}
    </p>
    {needsTickets && <div className="walkin-tickets">
      {receipt.tickets.filter(t => t.status === 'VALID').map(ticket => <div key={ticket.ticketUid} className="walkin-ticket">
        {/* eslint-disable-next-line @next/next/no-img-element -- QR codes are generated data URLs; next/image cannot optimise them */}
        {qrCodes[ticket.ticketUid] ? <img src={qrCodes[ticket.ticketUid]} alt={`QR code for ${ticket.ticketUid}`} width={140} height={140} /> : <div style={{ width: 140, height: 140 }} />}
        <strong>{ticket.ticketUid}</strong>
        <span>{ticket.name}</span>
        <span>{receipt.visitDate}</span>
      </div>)}
    </div>}
  </div>;
}

export default function WalkInsPage() {
  const { confirm, dialog } = useConfirm();
  const [prices, setPrices] = useState<PriceList>(DEFAULT_PRICES);
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [openingNote, setOpeningNote] = useState('');
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotError, setSpotError] = useState('');
  const [spotIds, setSpotIds] = useState<string[]>([]);
  const [method, setMethod] = useState<GatePaymentKey>('CASH');
  const [tendered, setTendered] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [checkIn, setCheckIn] = useState(true);
  const [customer, setCustomer] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [showCustomer, setShowCustomer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<WalkInReceipt | null>(null);
  const [cashUpDate, setCashUpDate] = useState(today());
  const [cashUp, setCashUp] = useState<CashUp | null>(null);
  const [cashUpError, setCashUpError] = useState('');
  const saleKey = useRef(newKey());

  const groups = useMemo(() => buildPackageGroups(prices), [prices]);
  const lines = groups.flatMap(group => group.items).filter(item => (selections[item.id] || 0) > 0).map(item => ({ ...item, qty: selections[item.id] }));
  const total = lines.reduce((sum, line) => sum + line.qty * line.price, 0);
  const people = lines.filter(line => !line.id.startsWith('hut-')).reduce((sum, line) => sum + line.qty, 0);
  const huts = selections['hut-covered'] || 0;
  const tables = selections['hut-shaded'] || 0;
  const chosenHuts = spots.filter(spot => spotIds.includes(spot.id) && spot.type === 'hut').length;
  const chosenTables = spots.filter(spot => spotIds.includes(spot.id) && spot.type === 'table').length;
  const tenderedValue = Number(tendered);
  const change = method === 'CASH' && tendered !== '' && Number.isFinite(tenderedValue) ? tenderedValue - total : null;
  const seatingReady = chosenHuts === huts && chosenTables === tables;
  const canSubmit = pricesLoaded && people > 0 && seatingReady && !submitting && (method !== 'CASH' || tendered === '' || (change !== null && change >= 0));

  const loadSpots = useCallback(async () => {
    setSpotError('');
    try {
      const response = await fetch(`/api/seating/availability?date=${today()}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Seating could not be loaded');
      setSpots([...data.spots].sort((a: Spot, b: Spot) => Number(a.number) - Number(b.number)));
    } catch (loadError) { setSpotError(loadError instanceof Error ? loadError.message : 'Seating could not be loaded'); }
  }, []);

  const loadCashUp = useCallback(async (date: string) => {
    setCashUpError('');
    try {
      const response = await fetch(`/api/admin/walk-ins?date=${date}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load walk-in sales');
      setCashUp(data);
    } catch (loadError) { setCashUpError(loadError instanceof Error ? loadError.message : 'Could not load walk-in sales'); }
  }, []);

  useEffect(() => {
    fetch('/api/prices', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Prices unavailable')))
      .then(data => { setPrices(data.prices); setPricesLoaded(true); })
      .catch(() => setError('Current prices could not be loaded. Refresh the page before selling.'));
    fetch(`/api/opening-info?from=${today().slice(0, 7)}&months=1`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        const entry = data?.dates?.find((d: { date: string }) => d.date === today());
        if (entry && !entry.open) setOpeningNote('Graceland is marked as closed today (opening rules or a closed date). You can still record sales at the gate.');
      })
      .catch(() => {});
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Load the cash-up for the chosen date; setState happens after the request
  useEffect(() => { loadCashUp(cashUpDate); }, [cashUpDate, loadCashUp]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch seating only once a hut or table is added; setState happens after the request
  useEffect(() => { if (huts + tables > 0 && !spots.length) loadSpots(); }, [huts, tables, spots.length, loadSpots]);

  const setQty = (id: string, qty: number) => {
    const next = Math.max(0, Math.min(500, qty));
    setSelections(current => ({ ...current, [id]: next }));
    // Drop seating choices that no longer fit the number of huts/tables.
    if (id === 'hut-covered' || id === 'hut-shaded') {
      const type = id === 'hut-covered' ? 'hut' : 'table';
      setSpotIds(current => {
        const ofType = current.filter(spotId => spots.find(spot => spot.id === spotId)?.type === type);
        const others = current.filter(spotId => !ofType.includes(spotId));
        return [...others, ...ofType.slice(0, next)];
      });
    }
  };

  const toggleSpot = (spot: Spot) => {
    setSpotIds(current => {
      if (current.includes(spot.id)) return current.filter(id => id !== spot.id);
      const limit = spot.type === 'hut' ? huts : tables;
      const ofType = current.filter(id => spots.find(s => s.id === id)?.type === spot.type);
      if (ofType.length >= limit) return [...current.filter(id => id !== ofType[0]), spot.id];
      return [...current, spot.id];
    });
  };

  const resetSale = () => {
    setSelections({}); setSpotIds([]); setTendered(''); setPaymentReference(''); setCheckIn(true);
    setCustomer({ firstName: '', lastName: '', phone: '', email: '' }); setShowCustomer(false);
    setReceipt(null); setError(''); setSpots([]);
    saleKey.current = newKey();
  };

  const completeSale = async () => {
    if (!canSubmit) return;
    const summary = `${lines.map(line => `${line.qty}× ${line.name}`).join('\n')}\n\nTotal: ${rand(total)} · ${GATE_PAYMENT_METHODS[method].label}${change !== null ? `\nCash received ${rand(tenderedValue)} → change ${rand(change)}` : ''}`;
    const result = await confirm({ title: 'Complete this sale?', message: `${summary}\n\n${checkIn ? 'Tickets will be checked in now.' : 'Tickets will be issued for scanning at the gate.'}`, confirmLabel: `Take ${rand(total)}` });
    if (!result.confirmed) return;
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/admin/walk-ins', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ selections, spotIds, paymentMethod: method, amountTendered: method === 'CASH' && tendered !== '' ? tenderedValue : null, paymentReference, checkIn, customer, expectedTotal: total, idempotencyKey: saleKey.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The sale could not be recorded');
      setReceipt(data.receipt);
      loadCashUp(cashUpDate);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (saleError) {
      setError(saleError instanceof Error ? saleError.message : 'The sale could not be recorded');
      // A seating clash means the map is stale.
      if (saleError instanceof Error && /seating/i.test(saleError.message)) { setSpotIds([]); loadSpots(); }
    } finally { setSubmitting(false); }
  };

  const reprint = async (sale: Sale) => {
    const response = await fetch(`/api/admin/walk-ins?bookingId=${sale.bookingId}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) { setCashUpError(data.error || 'Receipt could not be loaded'); return; }
    setReceipt(data.receipt);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const quickCash = [...new Set([total, Math.ceil(total / 50) * 50, Math.ceil(total / 100) * 100, Math.ceil(total / 200) * 200].filter(value => value >= total && value > 0))].slice(0, 4);

  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header no-print">
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>GATE</p><h1>Walk-in sales</h1><p style={{ color: 'var(--text-muted)' }}>Sell entry to guests at the gate for today, {new Date(`${today()}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}.</p></div>
      <nav className="admin-nav"><a className="btn" href="/admin/scanner" style={{ border: '1px solid var(--border-color)' }}>Scanner</a></nav>
    </div>
    {openingNote && <div className="callout callout-warning no-print" style={{ marginBottom: '1rem' }}><p>{openingNote}</p></div>}

    {receipt ? <Receipt receipt={receipt} onNewSale={resetSale} /> : <div className="walkin-layout no-print">
      <section className="card" style={{ margin: 0 }}>
        <h2 style={{ marginBottom: '0.5rem' }}>New sale</h2>
        {groups.map(group => <div key={group.category} style={{ marginTop: '1rem' }}>
          <h3 className="report-group-heading">{group.category}</h3>
          {group.items.map(item => {
            const qty = selections[item.id] || 0;
            return <div key={item.id} className={`walkin-item${qty ? ' active' : ''}`}>
              <div><div style={{ fontWeight: 600 }}>{item.name}</div><div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{rand(item.price)}</div></div>
              <div className="walkin-stepper">
                <button type="button" aria-label={`Remove ${item.name}, ${group.category.toLowerCase()}`} onClick={() => setQty(item.id, qty - 1)} disabled={!qty}>−</button>
                <span aria-live="polite">{qty}</span>
                <button type="button" aria-label={`Add ${item.name}, ${group.category.toLowerCase()}`} onClick={() => setQty(item.id, qty + 1)}>+</button>
              </div>
            </div>;
          })}
        </div>)}

        {huts + tables > 0 && <div style={{ marginTop: '1.25rem' }}>
          <h3 className="report-group-heading">Choose seating ({chosenHuts}/{huts} huts · {chosenTables}/{tables} tables)</h3>
          {spotError && <p style={{ color: 'var(--danger)' }}>{spotError} <button className="btn" onClick={loadSpots} style={{ border: '1px solid var(--border-color)', padding: '0.25rem 0.6rem' }}>Retry</button></p>}
          {(['hut', 'table'] as const).filter(type => (type === 'hut' ? huts : tables) > 0).map(type => <div key={type} className="walkin-spots">
            {spots.filter(spot => spot.type === type).map(spot => <button type="button" key={spot.id} disabled={!spot.available} title={spot.unavailableReason} onClick={() => toggleSpot(spot)} className={`walkin-spot${spotIds.includes(spot.id) ? ' selected' : ''}`}>{type === 'hut' ? 'Hut' : 'Table'} {spot.number}</button>)}
          </div>)}
        </div>}

        <div style={{ marginTop: '1.25rem' }}>
          <button type="button" className="btn" onClick={() => setShowCustomer(value => !value)} style={{ border: '1px solid var(--border-color)', fontSize: '0.9rem' }}>{showCustomer ? 'Hide customer details' : 'Add customer details (optional)'}</button>
          {showCustomer && <div className="walkin-customer">
            <input aria-label="First name" placeholder="First name" value={customer.firstName} onChange={event => setCustomer({ ...customer, firstName: event.target.value })} style={fieldStyle} />
            <input aria-label="Surname" placeholder="Surname" value={customer.lastName} onChange={event => setCustomer({ ...customer, lastName: event.target.value })} style={fieldStyle} />
            <input aria-label="Phone" type="tel" placeholder="Phone" value={customer.phone} onChange={event => setCustomer({ ...customer, phone: event.target.value })} style={fieldStyle} />
            <input aria-label="Email" type="email" placeholder="Email (tickets are emailed)" value={customer.email} onChange={event => setCustomer({ ...customer, email: event.target.value })} style={fieldStyle} />
          </div>}
        </div>
      </section>

      <aside className="card walkin-checkout" style={{ margin: 0 }}>
        <h2>Payment</h2>
        {lines.length === 0 ? <p style={{ color: 'var(--text-muted)', margin: '0.75rem 0' }}>Add tickets to start a sale.</p> : <table className="report-table" style={{ margin: '0.75rem 0' }}><tbody>
          {lines.map(line => <tr key={line.id}><td style={{ whiteSpace: 'normal' }}>{line.qty}× {line.name}</td><td style={{ textAlign: 'right' }}>{rand(line.qty * line.price)}</td></tr>)}
        </tbody></table>}
        <div className="walkin-total"><span>Total</span><strong>{rand(total)}</strong></div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{people} {people === 1 ? 'person' : 'people'}</p>

        <div className="walkin-methods" role="radiogroup" aria-label="Payment method">
          {(Object.keys(GATE_PAYMENT_METHODS) as GatePaymentKey[]).map(key => <button key={key} type="button" role="radio" aria-checked={method === key} className={`walkin-method${method === key ? ' selected' : ''}`} onClick={() => setMethod(key)}>{GATE_PAYMENT_METHODS[key].label}</button>)}
        </div>

        {method === 'CASH' ? <div style={{ marginTop: '0.75rem' }}>
          <label style={{ display: 'grid', gap: 4, fontWeight: 600, fontSize: '0.9rem' }}>Cash received
            <input type="number" inputMode="decimal" min={0} step="0.01" value={tendered} onChange={event => setTendered(event.target.value)} placeholder={total ? total.toFixed(2) : '0.00'} style={fieldStyle} />
          </label>
          {total > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>{quickCash.map(value => <button key={value} type="button" className="btn report-chip" onClick={() => setTendered(String(value))}>{value === total ? 'Exact' : rand(value)}</button>)}</div>}
          {change !== null && <p className="walkin-change" style={{ color: change < 0 ? 'var(--danger)' : 'var(--text-main)' }}>{change < 0 ? `Short by ${rand(-change)}` : <>Change: <strong>{rand(change)}</strong></>}</p>}
        </div> : <label style={{ display: 'grid', gap: 4, fontWeight: 600, fontSize: '0.9rem', marginTop: '0.75rem' }}>{method === 'CARD' ? 'Card slip / approval number (optional)' : 'Payment reference (optional)'}
          <input value={paymentReference} maxLength={80} onChange={event => setPaymentReference(event.target.value)} style={fieldStyle} />
        </label>}

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: '1rem', fontSize: '0.9rem' }}>
          <input type="checkbox" checked={checkIn} onChange={event => setCheckIn(event.target.checked)} style={{ marginTop: 3 }} />
          <span>Guests are entering now: check their tickets in straight away. Untick to print QR tickets to scan later.</span>
        </label>

        {!seatingReady && <p style={{ color: 'var(--warning-text)', fontSize: '0.85rem', marginTop: '0.75rem' }}>Choose the seating spots before completing the sale.</p>}
        {error && <p role="alert" style={{ color: 'var(--danger)', marginTop: '0.75rem' }}>{error}</p>}
        <button className="btn btn-primary walkin-submit" disabled={!canSubmit} onClick={completeSale}>{submitting ? 'Recording sale…' : total > 0 ? `Complete sale · ${rand(total)}` : 'Complete sale'}</button>
        {lines.length > 0 && <button type="button" className="btn" onClick={resetSale} style={{ width: '100%', marginTop: 8, border: '1px solid var(--border-color)' }}>Clear</button>}
      </aside>
    </div>}

    <section className="card no-print" style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div><h2>Cash-up</h2><p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{cashUp?.ownSalesOnly ? 'Your walk-in sales for the day.' : 'All walk-in sales for the day, per payment method and staff member.'}</p></div>
        <input type="date" value={cashUpDate} max={today()} onChange={event => setCashUpDate(event.target.value || today())} style={{ ...fieldStyle, width: 'auto' }} />
      </div>
      {cashUpError && <p role="alert" style={{ color: 'var(--danger)', marginTop: '0.75rem' }}>{cashUpError}</p>}
      {cashUp && <>
        <div className="report-mini-stats">
          <div><span>Sales</span><strong>{cashUp.totals.sales}</strong></div>
          <div><span>Total taken</span><strong>{rand(cashUp.totals.amount)}</strong></div>
          <div><span>Guests</span><strong>{cashUp.totals.people}</strong></div>
          {cashUp.byMethod.map(row => <div key={row.method}><span>{row.method} ({row.sales})</span><strong>{rand(row.amount)}</strong></div>)}
        </div>
        {!cashUp.ownSalesOnly && cashUp.byStaff.length > 0 && <>
          <h3 className="report-group-heading" style={{ marginTop: '1.25rem' }}>Per staff member</h3>
          <div className="admin-table-wrap"><table className="report-table"><thead><tr><th style={{ textAlign: 'left' }}>Staff</th><th style={{ textAlign: 'right' }}>Sales</th><th style={{ textAlign: 'right' }}>Guests</th><th style={{ textAlign: 'right' }}>Cash to hand in</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
            <tbody>{cashUp.byStaff.map(row => <tr key={row.name}><td>{row.name}</td><td style={{ textAlign: 'right' }}>{row.sales}</td><td style={{ textAlign: 'right' }}>{row.people}</td><td style={{ textAlign: 'right' }}>{rand(row.cash)}</td><td style={{ textAlign: 'right' }}>{rand(row.amount)}</td></tr>)}</tbody></table></div>
        </>}
        <h3 className="report-group-heading" style={{ marginTop: '1.25rem' }}>Sales</h3>
        {cashUp.sales.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>No walk-in sales on this day.</p> : <div className="admin-table-wrap"><table className="report-table">
          <thead><tr><th style={{ textAlign: 'left' }}>Time</th><th style={{ textAlign: 'left' }}>Reference</th><th style={{ textAlign: 'left' }}>Items</th><th style={{ textAlign: 'left' }}>Paid by</th>{!cashUp.ownSalesOnly && <th style={{ textAlign: 'left' }}>Sold by</th>}<th style={{ textAlign: 'right' }}>Total</th><th /></tr></thead>
          <tbody>{cashUp.sales.map(sale => <tr key={sale.bookingId} style={{ opacity: ['PAID', 'CONFIRMED'].includes(sale.status) ? 1 : 0.55 }}>
            <td>{time(sale.createdAt)}</td>
            <td>{sale.reference}{!['PAID', 'CONFIRMED'].includes(sale.status) && <span style={{ color: 'var(--danger)', marginLeft: 6 }}>{sale.status === 'CANCELLED' ? 'Refunded' : sale.status}</span>}</td>
            <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{sale.items}{sale.customerName && <span style={{ color: 'var(--text-muted)' }}> · {sale.customerName}</span>}</td>
            <td>{sale.paymentMethod.replace('Walk-in: ', '')}</td>
            {!cashUp.ownSalesOnly && <td>{sale.soldBy}</td>}
            <td style={{ textAlign: 'right' }}>{rand(sale.total)}</td>
            <td style={{ textAlign: 'right' }}><button className="btn" onClick={() => reprint(sale)} style={{ border: '1px solid var(--border-color)', padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}>Receipt</button></td>
          </tr>)}</tbody>
        </table></div>}
      </>}
    </section>
    {dialog}
  </main>;
}
