'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Kpi, Report, Row } from '@/lib/reports';
import Link from 'next/link';

type Basis = 'visit' | 'booked';
type Metric = 'Revenue (R)' | 'Visitors' | 'Paid bookings';

const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const shift = (date: string, days: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const monthEnd = (date: string) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** The season runs September to April; before September we are still in last year's season. */
function seasonRange(date: string) {
  const [year, month] = date.split('-').map(Number);
  const startYear = month >= 9 ? year : year - 1;
  return { from: `${startYear}-09-01`, to: `${startYear + 1}-04-30` };
}

const PRESETS: Array<{ id: string; label: string; range: () => { from: string; to: string } }> = [
  { id: '7d', label: 'Last 7 days', range: () => ({ from: shift(today(), -6), to: today() }) },
  { id: '30d', label: 'Last 30 days', range: () => ({ from: shift(today(), -29), to: today() }) },
  { id: 'month', label: 'This month', range: () => ({ from: monthStart(today()), to: monthEnd(today()) }) },
  { id: 'last-month', label: 'Last month', range: () => { const last = shift(monthStart(today()), -1); return { from: monthStart(last), to: monthEnd(last) }; } },
  { id: 'next30', label: 'Next 30 days', range: () => ({ from: today(), to: shift(today(), 29) }) },
  { id: 'season', label: 'This season', range: () => seasonRange(today()) },
  { id: 'year', label: 'This year', range: () => ({ from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` }) },
];

const rand = (value: number) => `R ${value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = (value: number) => value.toLocaleString('en-ZA', { maximumFractionDigits: 1 });

function formatCell(header: string, value: Row[string]) {
  if (typeof value !== 'number') return value ?? '—';
  if (header.includes('(R)')) return rand(value);
  if (header.includes('%')) return `${whole(value)}%`;
  return whole(value);
}

function formatKpi(kpi: Kpi, value: number) {
  if (kpi.format === 'currency') return rand(value);
  if (kpi.format === 'percent') return `${whole(value)}%`;
  if (kpi.format === 'days') return `${whole(value)} days`;
  return whole(value);
}

// KPIs where a rise is bad news.
const LOWER_IS_BETTER = new Set(['No-show bookings', 'Cancelled / refunded']);

function KpiCard({ kpi }: { kpi: Kpi }) {
  const previous = kpi.previous;
  // Rates change by percentage points; everything else by relative percent.
  const points = kpi.format === 'percent';
  const delta = previous ? (points ? kpi.value - previous : ((kpi.value - previous) / previous) * 100) : null;
  const good = delta !== null && (LOWER_IS_BETTER.has(kpi.label) ? delta < 0 : delta > 0);
  return <div className="card report-kpi" title={kpi.hint}>
    <p className="report-kpi-label">{kpi.label}</p>
    <strong className="report-kpi-value">{formatKpi(kpi, kpi.value)}</strong>
    {previous !== undefined && <p className="report-kpi-delta">
      {delta === null || Math.abs(delta) < 0.05
        ? <span style={{ color: 'var(--text-muted)' }}>{previous === null || previous === 0 ? 'No previous data' : 'No change'}</span>
        : <span style={{ color: good ? 'var(--success-text)' : 'var(--danger-text)', fontWeight: 700 }}>{delta > 0 ? '▲' : '▼'} {whole(Math.abs(delta))}{points ? ' pts' : '%'}</span>}
      {previous !== null && previous !== 0 && <span style={{ color: 'var(--text-muted)' }}> vs {formatKpi(kpi, previous)}</span>}
    </p>}
    {kpi.hint && <p className="report-kpi-hint">{kpi.hint}</p>}
  </div>;
}

function DataTable({ rows, maxRows }: { rows: Row[]; maxRows?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <p style={{ color: 'var(--text-muted)' }}>No data for this period.</p>;
  const headers = Object.keys(rows[0]);
  const visible = maxRows && !expanded ? rows.slice(0, maxRows) : rows;
  return <div className="admin-table-wrap">
    <table className="report-table">
      <thead><tr>{headers.map(header => <th key={header} style={{ textAlign: typeof rows[0][header] === 'number' ? 'right' : 'left' }}>{header}</th>)}</tr></thead>
      <tbody>{visible.map((row, i) => <tr key={i}>{headers.map(header => <td key={header} style={{ textAlign: typeof row[header] === 'number' ? 'right' : 'left' }}>{formatCell(header, row[header])}</td>)}</tr>)}</tbody>
    </table>
    {maxRows && rows.length > maxRows && <button className="btn" onClick={() => setExpanded(value => !value)} style={{ border: '1px solid var(--border-color)', marginTop: 8, fontSize: '0.85rem' }}>{expanded ? 'Show fewer' : `Show all ${rows.length} rows`}</button>}
  </div>;
}

/** Vertical columns for a time series or ordered categories. One series, one axis. */
function ColumnChart({ rows, labelKey, valueKey, height = 180, labelEvery }: { rows: Row[]; labelKey: string; valueKey: string; height?: number; labelEvery?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = rows.map(row => Number(row[valueKey] || 0));
  const max = Math.max(1, ...values);
  const every = labelEvery || Math.max(1, Math.ceil(rows.length / 12));
  if (!rows.length) return <p style={{ color: 'var(--text-muted)' }}>No data for this period.</p>;
  return <div className="report-columns-wrap">
    <div className="report-columns-axis" aria-hidden="true"><span>{formatCell(valueKey, max)}</span><span>{formatCell(valueKey, 0)}</span></div>
    <div className="report-columns" style={{ height }} role="img" aria-label={`${valueKey} by ${labelKey}`} onMouseLeave={() => setHover(null)}>
      {rows.map((row, i) => <div key={i} className="report-column-hit" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${row[labelKey]}: ${formatCell(valueKey, values[i])}`}>
        <div className={`report-column${hover === i ? ' active' : ''}`} style={{ height: `${(values[i] / max) * 100}%` }} />
        {hover === i && <div className="report-tooltip" style={{ [i > rows.length / 2 ? 'right' : 'left']: 0 }}><strong>{String(row[labelKey])}</strong><span>{valueKey.replace(' (R)', '')}: {formatCell(valueKey, values[i])}</span></div>}
      </div>)}
    </div>
    <div className="report-column-labels" aria-hidden="true">{rows.map((row, i) => <span key={i}>{i % every === 0 ? String(row[labelKey]).replace(/^\d{4}-/, '') : ''}</span>)}</div>
  </div>;
}

/** Horizontal bars for ranked categories, value labels on the right. */
function BarList({ rows, labelKey, valueKey, detailKey }: { rows: Row[]; labelKey: string; valueKey: string; detailKey?: string }) {
  const max = Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
  if (!rows.length) return <p style={{ color: 'var(--text-muted)' }}>No data for this period.</p>;
  return <div style={{ display: 'grid', gap: '0.7rem' }}>
    {rows.map((row, i) => <div key={i} title={`${row[labelKey]}: ${formatCell(valueKey, row[valueKey])}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.9rem' }}>
        <span style={{ wordBreak: 'break-word' }}>{String(row[labelKey])}</span>
        <strong style={{ whiteSpace: 'nowrap' }}>{formatCell(valueKey, row[valueKey])}{detailKey && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {formatCell(detailKey, row[detailKey])}</span>}</strong>
      </div>
      <div className="report-bar-track"><div className="report-bar" style={{ width: `${(Number(row[valueKey] || 0) / max) * 100}%` }} /></div>
    </div>)}
  </div>;
}

function Section({ title, subtitle, children, table }: { title: string; subtitle?: string; children?: React.ReactNode; table?: Row[] }) {
  return <section className="card report-section">
    <h2>{title}</h2>
    {subtitle && <p className="report-subtitle">{subtitle}</p>}
    {children}
    {table && table.length > 0 && <details className="report-details"><summary>View data table</summary><DataTable rows={table} /></details>}
  </section>;
}

export default function ReportsPage() {
  const initial = PRESETS[1].range();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState('30d');
  const [basis, setBasis] = useState<Basis>('visit');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [metric, setMetric] = useState<Metric>('Revenue (R)');

  const query = `from=${from}&to=${to}&basis=${basis}`;

  const load = useCallback(async () => {
    if (!from || !to || to < from) return;
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/admin/reports?${query}`, { headers: { Authorization: `Bearer ${await token()}` }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the report');
      setReport(data.report);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the report');
    } finally { setLoading(false); }
  }, [query, from, to]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Fetch the report whenever the range changes; setState happens after the request
  useEffect(() => { load(); }, [load]);

  const applyPreset = (id: string) => {
    const match = PRESETS.find(p => p.id === id);
    setPreset(id);
    if (match) { const range = match.range(); setFrom(range.from); setTo(range.to); }
  };

  const downloadExcel = async () => {
    setExporting(true); setError('');
    try {
      const response = await fetch(`/api/admin/reports/export?${query}`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Could not export the report'); }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `graceland-report-${from}-to-${to}${basis === 'booked' ? '-by-booking-date' : ''}.xlsx`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export the report');
    } finally { setExporting(false); }
  };

  // Long ranges read better as weeks or months than as hundreds of thin columns.
  const trend = useMemo(() => {
    if (!report) return { rows: [] as Row[], label: 'Date', unit: 'day' };
    if (report.daily.length > 400) return { rows: report.monthly, label: 'Month', unit: 'month' };
    if (report.daily.length > 92) return { rows: report.weekly, label: 'Week starting', unit: 'week' };
    return { rows: report.daily, label: 'Date', unit: 'day' };
  }, [report]);

  const dateWord = basis === 'visit' ? 'visit date' : 'booking date';
  const weekdayMetric = report ? Object.keys(report.weekdays[0] || {}).find(key => key.startsWith('Avg visitors')) || 'Visitors' : 'Visitors';
  const partyValue = (measure: string) => Number(report?.parties.summary.find(row => row.Measure === measure)?.Value || 0);

  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <div className="admin-header">
      <div><p style={{ color: 'var(--primary)', fontWeight: 700 }}>INSIGHTS</p><h1>Reports</h1></div>
      <nav className="admin-nav">
        <Link className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>Dashboard</Link>
        <Link className="btn" href="/admin/settings" style={{ border: '1px solid var(--border-color)' }}>Prices &amp; dates</Link>
        <button className="btn btn-primary" onClick={downloadExcel} disabled={exporting || loading || !report}>{exporting ? 'Preparing Excel…' : 'Download Excel'}</button>
      </nav>
    </div>

    <div className="card report-filters">
      <div className="report-presets" role="group" aria-label="Date range">
        {PRESETS.map(p => <button key={p.id} className={`btn report-chip${preset === p.id ? ' active' : ''}`} onClick={() => applyPreset(p.id)}>{p.label}</button>)}
      </div>
      <div className="report-filter-row">
        <label>From<input type="date" value={from} max={to} onChange={event => { setFrom(event.target.value); setPreset('custom'); }} /></label>
        <label>To<input type="date" value={to} min={from} onChange={event => { setTo(event.target.value); setPreset('custom'); }} /></label>
        <label>Count bookings by
          <select value={basis} onChange={event => setBasis(event.target.value as Basis)}>
            <option value="visit">Visit date (when guests come)</option>
            <option value="booked">Booking date (when the sale was made)</option>
          </select>
        </label>
        {loading && <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>Updating…</span>}
      </div>
    </div>

    {error && <div className="card" role="alert" style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</div>}
    {!report && loading && <div className="card">Loading report…</div>}

    {report && <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.2s' }}>
      <p style={{ color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>Compared with the previous {report.range.days} days ({report.range.previousFrom} to {report.range.previousTo}). Revenue counts paid bookings only.</p>
      <div className="report-kpis">{report.kpis.map(kpi => <KpiCard key={kpi.label} kpi={kpi} />)}</div>

      <Section title={`Trend by ${trend.unit}`} subtitle={`Paid bookings, grouped by ${dateWord}.`} table={trend.rows}>
        <div className="report-toggle" role="group" aria-label="Measure">
          {(['Revenue (R)', 'Visitors', 'Paid bookings'] as Metric[]).map(m => <button key={m} className={`btn report-chip${metric === m ? ' active' : ''}`} onClick={() => setMetric(m)}>{m.replace(' (R)', '')}</button>)}
        </div>
        <ColumnChart rows={trend.rows} labelKey={trend.label} valueKey={metric} height={220} />
      </Section>

      <div className="report-grid">
        <Section title="Busiest days of the week" subtitle={basis === 'visit' ? 'Average visitors per open day.' : 'Average visitors per day.'} table={report.weekdays}>
          <BarList rows={report.weekdays} labelKey="Weekday" valueKey={weekdayMetric} />
        </Section>
        <Section title="Booking outcomes" subtitle="What happened to every booking that was started." table={report.funnel}>
          <BarList rows={report.statusBreakdown} labelKey="Status" valueKey="Bookings" detailKey="Value (R)" />
        </Section>
      </div>

      <div className="report-grid">
        <Section title="Top sellers" subtitle="Revenue by package or item, paid bookings only." table={report.packages}>
          <BarList rows={report.packages.slice(0, 10)} labelKey="Item" valueKey="Revenue (R)" detailKey="Units sold" />
        </Section>
        <Section title="Who visits" subtitle="Visitor mix from paid tickets." table={report.visitorMix}>
          {report.visitorMix.length ? ['Age', 'Water activities'].map(group => <div key={group} style={{ marginBottom: '1rem' }}>
            <h3 className="report-group-heading">{group === 'Age' ? 'By age' : 'Swimming or not'}</h3>
            <BarList rows={report.visitorMix.filter(row => row.Group === group)} labelKey="Category" valueKey="Visitors" detailKey="Share %" />
          </div>) : <p style={{ color: 'var(--text-muted)' }}>No data for this period.</p>}
        </Section>
      </div>

      <div className="report-grid">
        <Section title="How customers pay" table={[...report.channels, ...report.paymentMethods]}>
          <h3 className="report-group-heading">Online vs walk-in</h3>
          <BarList rows={report.channels} labelKey="Channel" valueKey="Revenue (R)" detailKey="Paid bookings" />
          <h3 className="report-group-heading" style={{ marginTop: '1rem' }}>Payment method</h3>
          <BarList rows={report.paymentMethods} labelKey="Method" valueKey="Booking value (R)" detailKey="Bookings" />
        </Section>
        <Section title="Birthday parties" subtitle={`${partyValue('Party bookings')} parties · ${rand(partyValue('Party revenue (R)'))} · ${whole(partyValue('Share of revenue %'))}% of revenue`} table={[...report.parties.summary, ...report.parties.slots.map(row => ({ Measure: `Parties at ${row['Time slot']}`, Value: row.Parties })), ...report.parties.options.map(row => ({ Measure: `${row.Package} parties`, Value: row.Parties }))]}>
          {report.parties.slots.length ? <BarList rows={report.parties.slots} labelKey="Time slot" valueKey="Parties" detailKey="Revenue (R)" /> : <p style={{ color: 'var(--text-muted)' }}>No paid parties in this period.</p>}
          {report.parties.options.length > 0 && <div style={{ marginTop: '1rem' }}>
            <h3 className="report-group-heading">By package</h3>
            <BarList rows={report.parties.options} labelKey="Package" valueKey="Parties" detailKey="Revenue (R)" />
          </div>}
        </Section>
      </div>

      <div className="report-grid">
        <Section title="How far ahead people book" subtitle="Time between booking and visit." table={report.leadTime}>
          <BarList rows={report.leadTime} labelKey="Booked" valueKey="Paid bookings" detailKey="Share %" />
        </Section>
        <Section title="When bookings are made" subtitle="Hour of day (SA time) that paid bookings were placed." table={report.bookingHours}>
          <ColumnChart rows={report.bookingHours} labelKey="Hour" valueKey="Paid bookings" height={160} labelEvery={3} />
        </Section>
      </div>

      <div className="report-grid">
        <Section title="Gate check-ins" subtitle="Past visit dates only. A no-show is a paid booking with no ticket scanned." table={report.checkIns}>
          <DataTable rows={report.checkIns} maxRows={7} />
        </Section>
        <Section title="Busiest days" table={report.peakDays}>
          <BarList rows={report.peakDays.slice(0, 8).map(row => ({ ...row, Day: `${row.Date} (${String(row.Weekday).slice(0, 3)})` }))} labelKey="Day" valueKey="Visitors" detailKey={basis === 'visit' ? 'Capacity used %' : 'Revenue (R)'} />
        </Section>
      </div>

      <div className="report-grid">
        {report.seating && <Section title="Huts and tables" subtitle="Share of seating booked across open days." table={report.seating}>
          <BarList rows={report.seating} labelKey="Seating" valueKey="Utilisation %" detailKey="Spot-days booked" />
        </Section>}
        <Section title="Vouchers" subtitle="Voucher activity in this period, plus the balance still owed to customers.">
          <DataTable rows={report.vouchers} />
        </Section>
      </div>

      <Section title="Customers">
        <div className="report-mini-stats">{report.customers.summary.map(row => <div key={String(row.Measure)}><span>{String(row.Measure)}</span><strong>{formatCell(String(row.Measure), row.Value)}</strong></div>)}</div>
        <h3 style={{ margin: '1.25rem 0 0.5rem', fontSize: '1rem' }}>Top customers by spend</h3>
        <DataTable rows={report.customers.top} maxRows={10} />
      </Section>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '1rem 0' }}>The Excel download has every table above plus a sheet listing all {report.bookings.length} bookings in this period.</p>
    </div>}
  </main>;
}
