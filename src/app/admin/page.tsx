'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { PageHeader } from '@/components/admin/AdminShell';
import { AlertIcon, CalendarIcon, ReceiptIcon, ScanIcon, TicketIcon } from '@/components/admin/AdminIcons';
import { DownloadIcon } from '@/components/icons';

type Sales = { units: number; revenue: number };
type Overview = { date: string; today: { headcount: number; revenue: number; bookings: number; unscanned: number; scanned: number; capacity: number; breakdown: Record<string, Sales> }; comparison: { lastWeekHeadcount: number; percent: number | null }; pendingProofs: number };

const johannesburgToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const rand = (value: number) => `R ${value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Bar({ percent, tone = 'var(--primary)' }: { percent: number; tone?: string }) {
  return <div style={{ height: 10, background: '#e2e8f0', borderRadius: 6, marginTop: 8 }}><div style={{ height: '100%', width: `${Math.min(100, Math.max(0, percent))}%`, background: tone, borderRadius: 6, transition: 'width 0.3s' }} /></div>;
}

export default function AdminDashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(johannesburgToday);
  const [loading, setLoading] = useState(true);
  const [chartMode, setChartMode] = useState<'units' | 'revenue'>('units');
  const [conflictCount, setConflictCount] = useState(0);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the loading state while the chosen day's numbers are fetched
    setLoading(true); setError('');
    (async () => {
      const token = (await supabaseBrowser.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error('Staff session has expired');
      const headers = { Authorization: `Bearer ${token}` };
      const [overviewRes, conflictsRes] = await Promise.all([
        fetch(`/api/admin/overview?date=${selectedDate}`, { headers, cache: 'no-store' }),
        fetch(`/api/admin/conflicts?date=${selectedDate}`, { headers, cache: 'no-store' }).catch(() => null),
      ]);
      const body = await overviewRes.json();
      if (!overviewRes.ok) throw new Error(body.error);
      if (!active) return;
      setData(body);
      if (conflictsRes?.ok) setConflictCount((await conflictsRes.json()).count || 0);
    })().catch(err => { if (active) setError(err instanceof Error ? err.message : 'Could not load dashboard'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedDate]);

  const changeDate = (days: number) => setSelectedDate(current => { const [year, month, day] = current.split('-').map(Number); return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10); });
  const exportCsv = async () => {
    const session = (await supabaseBrowser.auth.getSession()).data.session;
    if (!session) return;
    const response = await fetch(`/api/admin/export?date=${selectedDate}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) { setError('Could not export bookings'); return; }
    const blob = await response.blob();
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `graceland-bookings-${selectedDate}.csv`; link.click(); URL.revokeObjectURL(link.href);
  };

  const isToday = selectedDate === johannesburgToday();
  const dateLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const header = <PageHeader
    eyebrow={isToday ? 'Today' : 'Daily overview'}
    title={dateLabel}
    description={loading && data ? 'Updating…' : undefined}
    actions={<>
      <div className="admin-date-nav">
        <button type="button" aria-label="Previous day" onClick={() => changeDate(-1)}>←</button>
        <input type="date" aria-label="Date" value={selectedDate} onChange={event => event.target.value && setSelectedDate(event.target.value)} />
        <button type="button" aria-label="Next day" onClick={() => changeDate(1)}>→</button>
      </div>
      {!isToday && <button type="button" className="btn btn-secondary" onClick={() => setSelectedDate(johannesburgToday())}>Today</button>}
      <button type="button" className="btn btn-secondary" onClick={exportCsv} style={{ gap: 6 }}><DownloadIcon size={15} /> Export CSV</button>
    </>}
  />;

  if (!data) return <main className="container" style={{ padding: '2rem 1rem' }}>{header}<div className="card" style={{ color: error ? 'var(--danger)' : 'var(--text-muted)' }}>{error || 'Loading dashboard…'}</div></main>;

  const { today } = data;
  const capacityPercent = today.capacity ? Math.round((today.headcount / today.capacity) * 100) : 0;
  const tickets = today.scanned + today.unscanned;
  const checkedInPercent = tickets ? Math.round((today.scanned / tickets) * 100) : 0;
  const comparison = data.comparison.percent === null ? 'No bookings on the same day last week' : `${data.comparison.percent >= 0 ? '▲' : '▼'} ${Math.abs(data.comparison.percent).toFixed(0)}% vs same day last week`;
  const sales = Object.entries(today.breakdown).sort((a, b) => (chartMode === 'units' ? b[1].units - a[1].units : b[1].revenue - a[1].revenue));
  const max = Math.max(1, ...sales.map(([, value]) => (chartMode === 'units' ? value.units : value.revenue)));

  return <main className="container" style={{ padding: '2rem 1rem' }}>
    {header}
    {error && <div className="callout callout-danger" style={{ marginBottom: '1rem' }}><p>{error}</p></div>}

    <div className="admin-quick-actions">
      <Link href="/admin/walk-ins" className="admin-quick-action"><span className="admin-quick-action-icon"><TicketIcon /></span><span>Walk-in sale<small>Sell entry at the gate</small></span></Link>
      <Link href="/admin/scanner" className="admin-quick-action"><span className="admin-quick-action-icon"><ScanIcon /></span><span>Scan tickets<small>Check guests in</small></span></Link>
      <Link href="/admin/proofs" className={`admin-quick-action${data.pendingProofs ? ' attention' : ''}`}><span className="admin-quick-action-icon"><ReceiptIcon /></span><span>{data.pendingProofs ? `${data.pendingProofs} proof${data.pendingProofs === 1 ? '' : 's'} to review` : 'Proofs of payment'}<small>{data.pendingProofs ? 'EFT payments waiting' : 'Nothing waiting'}</small></span></Link>
      {conflictCount > 0
        ? <Link href="/admin/conflicts" className="admin-quick-action attention"><span className="admin-quick-action-icon"><AlertIcon /></span><span>{conflictCount} check-in alert{conflictCount === 1 ? '' : 's'}<small>Tickets scanned twice</small></span></Link>
        : <Link href={`/admin/bookings?date=${selectedDate}`} className="admin-quick-action"><span className="admin-quick-action-icon"><CalendarIcon /></span><span>Day&apos;s bookings<small>Everyone booked for this date</small></span></Link>}
    </div>

    <div className="admin-stats">
      <div className="card">
        <p className="admin-stat-label">Guests booked</p>
        <strong className="admin-stat-value" style={{ color: 'var(--primary)' }}>{today.headcount}</strong>
        <p className="admin-stat-note">{comparison}</p>
      </div>
      <div className="card">
        <p className="admin-stat-label">Revenue</p>
        <strong className="admin-stat-value" style={{ color: 'var(--success-text)' }}>{rand(today.revenue)}</strong>
        <p className="admin-stat-note">{today.bookings} booking{today.bookings === 1 ? '' : 's'}</p>
      </div>
      <div className="card">
        <p className="admin-stat-label">Checked in</p>
        <strong className="admin-stat-value">{today.scanned}<span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}> / {tickets}</span></strong>
        <Bar percent={checkedInPercent} tone="var(--success)" />
        <p className="admin-stat-note" style={{ marginTop: 6 }}>{today.unscanned} ticket{today.unscanned === 1 ? '' : 's'} still to arrive</p>
      </div>
      <div className="card">
        <p className="admin-stat-label">Capacity used</p>
        <strong className="admin-stat-value">{capacityPercent}%</strong>
        <Bar percent={capacityPercent} tone={capacityPercent >= 90 ? 'var(--danger)' : capacityPercent >= 70 ? 'var(--warning)' : 'var(--success)'} />
        <p className="admin-stat-note" style={{ marginTop: 6 }}>{today.headcount} of {today.capacity} places</p>
      </div>
    </div>

    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div><h2 style={{ fontSize: '1.15rem' }}>Sales by pass type</h2><p className="admin-stat-note">Paid bookings for this date.</p></div>
        <div className="report-toggle" role="group" aria-label="Measure" style={{ margin: 0 }}>
          <button className={`btn report-chip${chartMode === 'units' ? ' active' : ''}`} onClick={() => setChartMode('units')}>Units</button>
          <button className={`btn report-chip${chartMode === 'revenue' ? ' active' : ''}`} onClick={() => setChartMode('revenue')}>Revenue</button>
        </div>
      </div>
      {sales.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>No paid sales for this date.</p> : <div style={{ display: 'grid', gap: '0.7rem' }}>
        {sales.map(([name, value]) => {
          const amount = chartMode === 'units' ? value.units : value.revenue;
          return <div key={name}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.9rem' }}><span style={{ wordBreak: 'break-word' }}>{name}</span><strong style={{ whiteSpace: 'nowrap' }}>{chartMode === 'units' ? value.units : rand(value.revenue)}</strong></div>
            <Bar percent={(amount / max) * 100} />
          </div>;
        })}
      </div>}
    </section>
  </main>;
}
