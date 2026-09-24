'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useConfirm } from '@/components/ConfirmDialog';
import Link from 'next/link';

type PriceRow = { key: string; label: string; group: string; defaultPrice: number; price: number; updatedAt: string | null };
type ClosedDate = { date: string; reason: string; createdAt: string; activeBookings: number; activePeople: number; paidBookings: number };
type Affected = { date: string; bookings: number; people: number; paid: number };

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
const johannesburgToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const formatDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const inputStyle = { padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: 8 } as const;

export default function SettingsPage() {
  const { confirm, dialog } = useConfirm();
  const [role, setRole] = useState('');

  // Prices
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [priceMessage, setPriceMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [savingPrices, setSavingPrices] = useState(false);

  // Closed dates
  const [closedDates, setClosedDates] = useState<ClosedDate[]>([]);
  const [closeFrom, setCloseFrom] = useState('');
  const [closeTo, setCloseTo] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [closureMessage, setClosureMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const canEditPrices = role === 'ADMIN';

  const loadPrices = useCallback(async () => {
    const response = await fetch('/api/admin/settings/prices', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load prices');
    setPrices(data.prices);
    setDrafts(Object.fromEntries((data.prices as PriceRow[]).map(row => [row.key, String(row.price)])));
  }, []);

  const loadClosedDates = useCallback(async () => {
    const response = await fetch('/api/admin/settings/closed-dates', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load closed dates');
    setClosedDates(data.closedDates);
  }, []);

  useEffect(() => {
    (async () => {
      const response = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      if (response.ok) setRole((await response.json()).role || '');
      await Promise.all([loadPrices(), loadClosedDates()]);
    })().catch(error => setLoadError(error instanceof Error ? error.message : 'Could not load settings'));
  }, [loadPrices, loadClosedDates]);

  const changedPrices = useMemo(() => prices.filter(row => drafts[row.key] !== undefined && Number(drafts[row.key]) !== row.price), [prices, drafts]);
  const groups = useMemo(() => {
    const map = new Map<string, PriceRow[]>();
    prices.forEach(row => map.set(row.group, [...(map.get(row.group) || []), row]));
    return [...map.entries()];
  }, [prices]);

  const savePrices = async () => {
    if (!changedPrices.length) return;
    const invalid = changedPrices.find(row => drafts[row.key].trim() === '' || !Number.isFinite(Number(drafts[row.key])) || Number(drafts[row.key]) < 0);
    if (invalid) { setPriceMessage({ tone: 'error', text: `${invalid.label}: enter a valid amount.` }); return; }
    const summary = changedPrices.map(row => `${row.group} · ${row.label}: R ${row.price.toFixed(2)} → R ${Number(drafts[row.key]).toFixed(2)}`).join('\n');
    const result = await confirm({ title: `Update ${changedPrices.length} price${changedPrices.length === 1 ? '' : 's'}?`, message: `${summary}\n\nNew bookings are charged the new prices straight away. Existing bookings keep the price they were booked at.`, confirmLabel: 'Update prices' });
    if (!result.confirmed) return;
    setSavingPrices(true); setPriceMessage(null);
    try {
      const response = await fetch('/api/admin/settings/prices', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prices: Object.fromEntries(changedPrices.map(row => [row.key, Number(drafts[row.key])])) }),
      });
      const data = await response.json();
      setPriceMessage({ tone: response.ok ? 'ok' : 'error', text: data.message || data.error });
      if (response.ok) await loadPrices();
    } finally { setSavingPrices(false); }
  };

  const closeDates = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!closeFrom) return;
    const to = closeTo || closeFrom;
    setClosing(true); setClosureMessage(null);
    try {
      const headers = { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' };
      const previewResponse = await fetch('/api/admin/settings/closed-dates', { method: 'POST', headers, body: JSON.stringify({ from: closeFrom, to, reason: closeReason, preview: true }) });
      const preview = await previewResponse.json();
      if (!previewResponse.ok) { setClosureMessage({ tone: 'error', text: preview.error }); return; }
      const affected = preview.affected as Affected[];
      const bookingCount = affected.reduce((sum, row) => sum + row.bookings, 0);
      const range = closeFrom === to ? formatDate(closeFrom) : `${formatDate(closeFrom)} to ${formatDate(to)} (${preview.dates} days)`;
      const warning = bookingCount
        ? `\n\n⚠ ${bookingCount} booking${bookingCount === 1 ? '' : 's'} (${affected.reduce((sum, row) => sum + row.people, 0)} people) already ${bookingCount === 1 ? 'exists' : 'exist'} on:\n${affected.map(row => `• ${formatDate(row.date)}: ${row.bookings} booking${row.bookings === 1 ? '' : 's'}, ${row.paid} paid`).join('\n')}\n\nClosing does not cancel them. Use "Refund all bookings for date" on the bookings page afterwards.`
        : '\n\nNo existing bookings are affected.';
      const result = await confirm({ title: 'Close for bookings?', message: `Customers will not be able to book ${range}.${closeReason ? `\nReason: ${closeReason}` : ''}${warning}`, confirmLabel: 'Close dates', tone: 'danger' });
      if (!result.confirmed) return;
      const response = await fetch('/api/admin/settings/closed-dates', { method: 'POST', headers, body: JSON.stringify({ from: closeFrom, to, reason: closeReason }) });
      const data = await response.json();
      setClosureMessage({ tone: response.ok ? 'ok' : 'error', text: data.message || data.error });
      if (response.ok) { setCloseFrom(''); setCloseTo(''); setCloseReason(''); await loadClosedDates(); }
    } finally { setClosing(false); }
  };

  const reopen = async (entry: ClosedDate) => {
    const result = await confirm({ title: 'Reopen date?', message: `Allow bookings on ${formatDate(entry.date)} again? The regular opening rules still apply.`, confirmLabel: 'Reopen' });
    if (!result.confirmed) return;
    const response = await fetch(`/api/admin/settings/closed-dates?date=${entry.date}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } });
    const data = await response.json();
    setClosureMessage({ tone: response.ok ? 'ok' : 'error', text: data.message || data.error });
    if (response.ok) await loadClosedDates();
  };

  const messageStyle = (tone: 'ok' | 'error') => ({ marginTop: '0.75rem', color: tone === 'ok' ? 'var(--success-text)' : 'var(--danger)', whiteSpace: 'pre-line' as const });

  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header">
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>VENUE SETTINGS</p><h1>Prices &amp; closed dates</h1></div>
      <nav className="admin-nav"><Link className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Dashboard</Link><Link className="btn" href="/admin/reports" style={{ border: '1px solid var(--border-color)' }}>Reports</Link></nav>
    </div>
    {loadError && <div className="card" style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{loadError}</div>}

    <section className="card" style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2>Closed dates</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>Close extra days on top of the regular opening rules (for maintenance, weather or private events). Closed days are greyed out on the booking calendar.</p>
        </div>
      </div>
      <form onSubmit={closeDates} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '1rem' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600 }}>From<input type="date" required min={johannesburgToday()} value={closeFrom} onChange={event => { setCloseFrom(event.target.value); if (closeTo && closeTo < event.target.value) setCloseTo(''); }} style={inputStyle} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600 }}>To (optional)<input type="date" min={closeFrom || johannesburgToday()} value={closeTo} onChange={event => setCloseTo(event.target.value)} style={inputStyle} /></label>
        <label style={{ display: 'grid', gap: 4, fontSize: '0.85rem', fontWeight: 600, flex: '1 1 220px' }}>Reason (staff only)<input maxLength={200} value={closeReason} onChange={event => setCloseReason(event.target.value)} placeholder="e.g. Pool maintenance" style={inputStyle} /></label>
        <button className="btn btn-primary" disabled={!closeFrom || closing}>{closing ? 'Checking…' : 'Close dates'}</button>
      </form>
      {closureMessage && <p role="status" style={messageStyle(closureMessage.tone)}>{closureMessage.text}</p>}
      <div className="admin-table-wrap" style={{ marginTop: '1rem' }}>
        {closedDates.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>No upcoming dates have been closed from the admin panel.</p> :
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead><tr>{['Date', 'Reason', 'Bookings still on this date', ''].map(header => <th key={header} style={{ textAlign: 'left', padding: 10, borderBottom: '2px solid var(--border-color)' }}>{header}</th>)}</tr></thead>
            <tbody>{closedDates.map(entry => <tr key={entry.date} style={{ borderBottom: '1px solid var(--border-color)' }}>
              <td style={{ padding: 10, whiteSpace: 'nowrap', fontWeight: 600 }}>{formatDate(entry.date)}</td>
              <td style={{ padding: 10 }}>{entry.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              <td style={{ padding: 10 }}>{entry.activeBookings ? <Link href="/admin/bookings" style={{ color: 'var(--danger)', fontWeight: 600 }}>{entry.activeBookings} booking{entry.activeBookings === 1 ? '' : 's'} · {entry.activePeople} people →</Link> : <span style={{ color: 'var(--text-muted)' }}>None</span>}</td>
              <td style={{ padding: 10, textAlign: 'right' }}><button className="btn" onClick={() => reopen(entry)} style={{ border: '1px solid var(--border-color)', padding: '0.35rem 0.75rem' }}>Reopen</button></td>
            </tr>)}</tbody>
          </table>}
      </div>
    </section>

    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2>Prices</h2>
          <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>{canEditPrices ? 'Change a price and save. New bookings are charged the new price straight away; existing bookings are not affected.' : 'Only administrators can change prices.'}</p>
        </div>
        {canEditPrices && <button className="btn btn-primary" onClick={savePrices} disabled={!changedPrices.length || savingPrices}>{savingPrices ? 'Saving…' : changedPrices.length ? `Save ${changedPrices.length} change${changedPrices.length === 1 ? '' : 's'}` : 'No changes'}</button>}
      </div>
      {priceMessage && <p role="status" style={messageStyle(priceMessage.tone)}>{priceMessage.text}</p>}
      {groups.map(([group, rows]) => <div key={group} style={{ marginTop: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', color: 'var(--primary)', borderBottom: '1px solid var(--border-color)', paddingBottom: 6, marginBottom: 6 }}>{group}</h3>
        {rows.map(row => {
          const draft = drafts[row.key] ?? String(row.price);
          const changed = Number(draft) !== row.price;
          const differsFromDefault = row.price !== row.defaultPrice;
          return <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0.5rem 0', flexWrap: 'wrap', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ flex: '1 1 220px' }}>
              <div style={{ fontWeight: 600 }}>{row.label}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                {differsFromDefault ? `Changed from the original R ${row.defaultPrice.toFixed(2)}${row.updatedAt ? ` on ${new Date(row.updatedAt).toLocaleDateString()}` : ''}` : 'Original price'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>R</span>
              <input aria-label={`${group} ${row.label} price`} type="number" min={0} step="0.01" inputMode="decimal" disabled={!canEditPrices} value={draft} onChange={event => setDrafts(current => ({ ...current, [row.key]: event.target.value }))} style={{ ...inputStyle, width: 110, textAlign: 'right', borderColor: changed ? 'var(--warning)' : 'var(--border-color)', background: changed ? 'var(--warning-bg)' : undefined }} />
              {canEditPrices && differsFromDefault && <button type="button" className="btn" title="Put back the original price" onClick={() => setDrafts(current => ({ ...current, [row.key]: String(row.defaultPrice) }))} style={{ border: '1px solid var(--border-color)', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}>Reset</button>}
            </div>
          </div>;
        })}
      </div>)}
    </section>
    {dialog}
  </main>;
}
