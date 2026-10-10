'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/admin/AdminShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { DownloadIcon } from '@/components/icons';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { buildPackageGroups, calculateServerTotal, DEFAULT_PRICES, type PriceList } from '@/lib/pricing';
import { getPartySlots, type PartyDetails } from '@/lib/parties';
import { seasonEndDate } from '@/lib/opening-rules';
import { spotLabel } from '@/lib/seating';

type Spot = { id: string; number: string; type: 'hut' | 'table'; available: boolean; unavailableReason?: string; recommended?: boolean };
type PaymentKey = 'CASH' | 'CARD' | 'EFT';
type Result = { reference: string; total: number; ticketsEmailed: boolean | null; eftSent: boolean | null; created: boolean; email: string };
type ImportResult = { row: number; name: string; date: string; people: number; ok: boolean; message: string; reference?: string };

const PAYMENT_LABELS: Record<PaymentKey, string> = { CASH: 'Cash', CARD: 'Card machine', EFT: 'EFT received' };
const token = async () => (await supabaseBrowser.auth.getSession()).data.session?.access_token || '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
const rand = (value: number) => `R ${value.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const fieldStyle = { padding: '0.65rem', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: '1rem', width: '100%' } as const;
const labelStyle = { display: 'grid', gap: 4, fontWeight: 600, fontSize: '0.9rem' } as const;

function Stepper({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (value: number) => void; min?: number }) {
  return <div className={`walkin-item${value ? ' active' : ''}`}>
    <div style={{ fontWeight: 600 }}>{label}</div>
    <div className="walkin-stepper">
      <button type="button" aria-label={`Fewer: ${label}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label={`More: ${label}`} onClick={() => onChange(Math.min(500, value + 1))}>+</button>
    </div>
  </div>;
}

export default function AddBookingPage() {
  const [tab, setTab] = useState<'new' | 'import'>('new');
  return <main className="container" style={{ padding: '2rem 1rem' }}>
    <PageHeader eyebrow="Bookings" title="Add booking" description="Enter a booking taken by phone or at the office, or import bookings from the booking book." />
    <div className="report-toggle" role="tablist" aria-label="Add booking" style={{ marginBottom: '1rem' }}>
      <button role="tab" aria-selected={tab === 'new'} className={`btn report-chip${tab === 'new' ? ' active' : ''}`} onClick={() => setTab('new')}>New booking</button>
      <button role="tab" aria-selected={tab === 'import'} className={`btn report-chip${tab === 'import' ? ' active' : ''}`} onClick={() => setTab('import')}>Import from booking book</button>
    </div>
    {tab === 'new' ? <NewBooking /> : <ImportBookings />}
  </main>;
}

// ── New booking (phone / office) ──────────────────────────────────────────

function NewBooking() {
  const { confirm, dialog } = useConfirm();
  const [prices, setPrices] = useState<PriceList>(DEFAULT_PRICES);
  const [pricesLoaded, setPricesLoaded] = useState(false);
  const [date, setDate] = useState('');
  const [customer, setCustomer] = useState({ firstName: '', lastName: '', phone: '', email: '' });
  const [isParty, setIsParty] = useState(false);
  const [party, setParty] = useState({ option: 'option-1' as PartyDetails['option'], slot: '', children: 10, adultsSwim: 0, adultsDry: 0, kidsSwim: 0, kidsDry: 0, packs: 0 });
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotIds, setSpotIds] = useState<string[]>([]);
  const [spotError, setSpotError] = useState('');
  const [paid, setPaid] = useState(true);
  const [method, setMethod] = useState<PaymentKey>('CASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const bookingKey = useRef(newKey());

  useEffect(() => {
    fetch('/api/prices', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Prices unavailable')))
      .then(data => { setPrices(data.prices); setPricesLoaded(true); })
      .catch(() => setError('Current prices could not be loaded. Refresh the page.'));
  }, []);

  const groups = useMemo(() => buildPackageGroups(prices), [prices]);
  const slots = useMemo(() => (date ? [...getPartySlots(date)] as string[] : []), [date]);
  const partyDetails: PartyDetails | undefined = isParty ? {
    enabled: true, option: party.option, slot: party.slot, children: party.children,
    adults: party.adultsSwim + party.adultsDry, adultsWater: [...Array(party.adultsSwim).fill(true), ...Array(party.adultsDry).fill(false)],
    additionalChildren: party.kidsSwim + party.kidsDry, additionalChildrenWater: [...Array(party.kidsSwim).fill(true), ...Array(party.kidsDry).fill(false)],
    partyPacks: party.packs,
  } : undefined;
  const { lineItems, total } = calculateServerTotal(selections, partyDetails, prices);
  const huts = (selections['hut-covered'] || 0) + (isParty ? 1 : 0);
  const tables = selections['hut-shaded'] || 0;
  const chosenHuts = spots.filter(spot => spotIds.includes(spot.id) && spot.type === 'hut').length;
  const chosenTables = spots.filter(spot => spotIds.includes(spot.id) && spot.type === 'table').length;
  const people = lineItems.filter(line => line.isPerson).reduce((sum, line) => sum + line.quantity, 0);
  const seatingReady = chosenHuts === huts && chosenTables === tables;
  const customerReady = customer.firstName.trim() && customer.lastName.trim() && (customer.phone.trim() || customer.email.trim()) && (paid || customer.email.trim());
  const canSubmit = pricesLoaded && Boolean(date) && Boolean(customerReady) && people > 0 && (!isParty || Boolean(party.slot)) && seatingReady && !submitting;

  const loadSpots = useCallback(async () => {
    setSpotError(''); setSpots([]);
    if (!date || huts + tables === 0 || (isParty && !party.slot)) return;
    try {
      const params = new URLSearchParams({ date, isParty: String(isParty), partySlot: isParty ? party.slot : '' });
      const response = await fetch(`/api/seating/availability?${params}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Seating could not be loaded');
      setSpots(data.spots);
    } catch (loadError) { setSpotError(loadError instanceof Error ? loadError.message : 'Seating could not be loaded'); }
  }, [date, huts, tables, isParty, party.slot]);

  // Seating depends on the date, the party slot and how many huts/tables are needed.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- setState happens after the request
  useEffect(() => { loadSpots(); }, [loadSpots]);
  // A new date or slot makes earlier seating choices meaningless.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing dependent choices
  useEffect(() => { setSpotIds([]); }, [date, isParty, party.slot]);

  const setQty = (id: string, qty: number) => {
    const next = Math.max(0, Math.min(500, qty));
    setSelections(current => ({ ...current, [id]: next }));
    if (id === 'hut-covered' || id === 'hut-shaded') setSpotIds([]);
  };
  const toggleSpot = (spot: Spot) => setSpotIds(current => {
    if (current.includes(spot.id)) return current.filter(id => id !== spot.id);
    const limit = spot.type === 'hut' ? huts : tables;
    const ofType = current.filter(id => spots.find(s => s.id === id)?.type === spot.type);
    if (ofType.length >= limit) return [...current.filter(id => id !== ofType[0]), spot.id];
    return [...current, spot.id];
  });

  const reset = () => {
    setDate(''); setCustomer({ firstName: '', lastName: '', phone: '', email: '' }); setIsParty(false);
    setParty({ option: 'option-1', slot: '', children: 10, adultsSwim: 0, adultsDry: 0, kidsSwim: 0, kidsDry: 0, packs: 0 });
    setSelections({}); setSpotIds([]); setPaid(true); setMethod('CASH'); setPaymentReference(''); setNotes('');
    setResult(null); setError(''); bookingKey.current = newKey();
  };

  const submit = async () => {
    if (!canSubmit) return;
    const summary = `${customer.firstName} ${customer.lastName} · ${date}${isParty ? ` · party ${party.slot}` : ''}\n${lineItems.filter(line => line.quantity > 0 && line.subtotal >= 0).map(line => `${line.quantity}× ${line.name}`).join('\n')}${spotIds.length ? `\nSeating: ${spots.filter(spot => spotIds.includes(spot.id)).map(spot => spotLabel(spot.type, spot.number)).join(', ')}` : ''}\n\nTotal: ${rand(total)}\n${paid ? `Paid: ${PAYMENT_LABELS[method]}${customer.email ? ' · QR tickets will be emailed' : ' · no email, so no tickets are emailed'}` : 'Not paid: EFT payment instructions will be emailed (the booking keeps its places until the end of the visit day)'}`;
    const answer = await confirm({ title: 'Save this booking?', message: summary, confirmLabel: 'Save booking' });
    if (!answer.confirmed) return;
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/admin/add-booking', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitDate: date, customer, selections, party: partyDetails, spotIds, notes, payment: paid ? { method, reference: paymentReference } : null, expectedTotal: total, idempotencyKey: bookingKey.current }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The booking could not be saved');
      setResult({ ...data, email: customer.email });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The booking could not be saved');
      if (saveError instanceof Error && /seating|taken|hut|table/i.test(saveError.message)) { setSpotIds([]); loadSpots(); }
    } finally { setSubmitting(false); }
  };

  if (result) {
    return <section className="card">
      <p style={{ color: 'var(--success-text)', fontWeight: 700 }}>✓ Booking saved</p>
      <h2 style={{ margin: '0.25rem 0' }}>{result.reference}</h2>
      <p>Total {rand(result.total)}.</p>
      <p style={{ marginTop: '0.5rem' }}>
        {result.ticketsEmailed === true && `QR tickets were emailed to ${result.email}.`}
        {result.ticketsEmailed === false && 'The tickets are ready, but the email could not be sent. It is listed under Email retries.'}
        {result.ticketsEmailed === null && result.eftSent === null && 'No email address, so no tickets were emailed. At the gate, find the guest by name or phone in the scanner search.'}
        {result.eftSent === true && `EFT payment instructions were emailed to ${result.email}. The booking keeps its places until the end of the visit day; approve the proof of payment when it arrives.`}
        {result.eftSent === false && 'The EFT instructions could not be emailed. They are listed under Email retries; the booking is only held for 15 minutes until they are sent.'}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: '1rem', flexWrap: 'wrap' }}>
        <Link className="btn btn-secondary" href={`/admin/bookings?q=${encodeURIComponent(result.reference)}`}>Open booking</Link>
        <button type="button" className="btn btn-primary" onClick={reset}>Add another booking</button>
      </div>
    </section>;
  }

  return <div className="walkin-layout">
    <section className="card" style={{ margin: 0 }}>
      <h2 style={{ marginBottom: '0.75rem' }}>Booking details</h2>
      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <label style={labelStyle}>Visit date<input type="date" value={date} min={today()} max={seasonEndDate()} onChange={event => setDate(event.target.value)} style={fieldStyle} /></label>
        <label style={labelStyle}>First name<input value={customer.firstName} onChange={event => setCustomer({ ...customer, firstName: event.target.value })} style={fieldStyle} /></label>
        <label style={labelStyle}>Surname<input value={customer.lastName} onChange={event => setCustomer({ ...customer, lastName: event.target.value })} style={fieldStyle} /></label>
        <label style={labelStyle}>Phone<input type="tel" value={customer.phone} onChange={event => setCustomer({ ...customer, phone: event.target.value })} style={fieldStyle} /></label>
        <label style={labelStyle}>Email<input type="email" value={customer.email} placeholder="Tickets are emailed here" onChange={event => setCustomer({ ...customer, email: event.target.value })} style={fieldStyle} /></label>
      </div>

      <div className="report-toggle" role="radiogroup" aria-label="Booking type" style={{ margin: '1.25rem 0 0.5rem' }}>
        <button type="button" role="radio" aria-checked={!isParty} className={`btn report-chip${!isParty ? ' active' : ''}`} onClick={() => setIsParty(false)}>Day visitors</button>
        <button type="button" role="radio" aria-checked={isParty} className={`btn report-chip${isParty ? ' active' : ''}`} onClick={() => setIsParty(true)}>Birthday party</button>
      </div>

      {isParty && <div style={{ marginTop: '0.5rem' }}>
        <h3 className="report-group-heading">Birthday party</h3>
        {!date ? <p style={{ color: 'var(--text-muted)' }}>Choose the visit date first.</p> : !slots.length ? <p className="callout callout-warning">There are no party time slots on this date.</p> : <>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: '0.5rem' }}>
            <label style={labelStyle}>Time slot<select value={party.slot} onChange={event => setParty({ ...party, slot: event.target.value })} style={fieldStyle}><option value="">Choose a slot</option>{slots.map(slot => <option key={slot} value={slot}>{slot}</option>)}</select></label>
            <label style={labelStyle}>Party option<select value={party.option} onChange={event => setParty({ ...party, option: event.target.value as PartyDetails['option'] })} style={fieldStyle}><option value="option-1">Option 1</option><option value="option-2">Option 2 (with hotdog)</option></select></label>
          </div>
          <Stepper label="Party children" value={party.children} min={1} onChange={value => setParty({ ...party, children: value })} />
          <Stepper label="Adults (swimming)" value={party.adultsSwim} onChange={value => setParty({ ...party, adultsSwim: value })} />
          <Stepper label="Adults (not swimming)" value={party.adultsDry} onChange={value => setParty({ ...party, adultsDry: value })} />
          <Stepper label="Extra children (swimming)" value={party.kidsSwim} onChange={value => setParty({ ...party, kidsSwim: value })} />
          <Stepper label="Extra children (not swimming)" value={party.kidsDry} onChange={value => setParty({ ...party, kidsDry: value })} />
          <Stepper label="Party packs" value={party.packs} onChange={value => setParty({ ...party, packs: value })} />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 6 }}>A party includes one hut. Add day-visitor tickets below only for guests who are not part of the party.</p>
        </>}
      </div>}

      {groups.map(group => <div key={group.category} style={{ marginTop: '1rem' }}>
        <h3 className="report-group-heading">{group.category}</h3>
        {group.items.map(item => {
          const qty = selections[item.id] || 0;
          return <div key={item.id} className={`walkin-item${qty ? ' active' : ''}`}>
            <div><div style={{ fontWeight: 600 }}>{item.name}</div><div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{rand(item.price)}</div></div>
            <div className="walkin-stepper">
              <button type="button" aria-label={`Remove ${item.name}`} onClick={() => setQty(item.id, qty - 1)} disabled={!qty}>−</button>
              <span aria-live="polite">{qty}</span>
              <button type="button" aria-label={`Add ${item.name}`} onClick={() => setQty(item.id, qty + 1)}>+</button>
            </div>
          </div>;
        })}
      </div>)}

      {huts + tables > 0 && <div style={{ marginTop: '1.25rem' }}>
        <h3 className="report-group-heading">Choose seating ({chosenHuts}/{huts} huts · {chosenTables}/{tables} tables)</h3>
        {!date || (isParty && !party.slot) ? <p style={{ color: 'var(--text-muted)' }}>Choose the date{isParty ? ' and party time slot' : ''} to see which huts and tables are free.</p> : <>
          {spotError && <p style={{ color: 'var(--danger)' }}>{spotError} <button className="btn" onClick={loadSpots} style={{ border: '1px solid var(--border-color)', padding: '0.25rem 0.6rem' }}>Retry</button></p>}
          {(['hut', 'table'] as const).filter(type => (type === 'hut' ? huts : tables) > 0).map(type => <div key={type} className="walkin-spots">
            {spots.filter(spot => spot.type === type).map(spot => <button type="button" key={spot.id} disabled={!spot.available} title={spot.unavailableReason || (spot.recommended ? 'Recommended: free during this party' : undefined)} onClick={() => toggleSpot(spot)} className={`walkin-spot${spotIds.includes(spot.id) ? ' selected' : ''}`} style={spot.recommended && !spotIds.includes(spot.id) ? { boxShadow: '0 0 0 2px #f59e0b' } : undefined}>{spotLabel(type, spot.number)}</button>)}
          </div>)}
          {isParty && spots.some(spot => spot.recommended && spot.available) && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Huts with an orange ring are recommended: another party uses them at a different time.</p>}
        </>}
      </div>}

      <label style={{ ...labelStyle, marginTop: '1.25rem' }}>Notes (staff only)<textarea value={notes} maxLength={500} rows={2} onChange={event => setNotes(event.target.value)} style={fieldStyle} placeholder="e.g. Booked by phone, bringing own cake" /></label>
    </section>

    <aside className="card walkin-checkout" style={{ margin: 0 }}>
      <h2>Summary</h2>
      {people === 0 ? <p style={{ color: 'var(--text-muted)', margin: '0.75rem 0' }}>Add people to the booking.</p> : <table className="report-table" style={{ margin: '0.75rem 0' }}><tbody>
        {lineItems.filter(line => line.subtotal > 0 || line.isPerson).map(line => <tr key={`${line.itemId}-${line.name}`}><td>{line.quantity}× {line.name}</td><td style={{ textAlign: 'right' }}>{rand(line.subtotal)}</td></tr>)}
      </tbody></table>}
      <div className="walkin-total"><span>Total</span><strong>{rand(total)}</strong></div>

      <div className="walkin-methods" role="radiogroup" aria-label="Payment" style={{ marginTop: '0.75rem' }}>
        <button type="button" role="radio" aria-checked={paid} className={`walkin-method${paid ? ' selected' : ''}`} onClick={() => setPaid(true)}>Paid</button>
        <button type="button" role="radio" aria-checked={!paid} className={`walkin-method${!paid ? ' selected' : ''}`} onClick={() => setPaid(false)}>Not paid yet</button>
      </div>
      {paid ? <>
        <div className="walkin-methods" role="radiogroup" aria-label="Payment method" style={{ marginTop: '0.5rem' }}>
          {(Object.keys(PAYMENT_LABELS) as PaymentKey[]).map(key => <button key={key} type="button" role="radio" aria-checked={method === key} className={`walkin-method${method === key ? ' selected' : ''}`} onClick={() => setMethod(key)}>{PAYMENT_LABELS[key]}</button>)}
        </div>
        <label style={{ ...labelStyle, marginTop: '0.75rem' }}>Receipt / payment reference (optional)<input value={paymentReference} maxLength={80} onChange={event => setPaymentReference(event.target.value)} style={fieldStyle} /></label>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 6 }}>Only choose Paid once the money has been received. {customer.email ? 'QR tickets are emailed to the customer.' : 'Without an email address, no tickets are emailed; the gate finds the guest by name or phone.'}</p>
      </> : <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 6 }}>The customer is emailed the EFT payment details. The booking keeps its places until the end of the visit day (only online bookings have 48 hours to pay). {customer.email ? '' : <strong>An email address is required.</strong>}</p>}

      {error && <p role="alert" className="callout callout-danger" style={{ marginTop: '0.75rem' }}>{error}</p>}
      {!seatingReady && huts + tables > 0 && <p style={{ color: 'var(--warning-text)', fontSize: '0.85rem', marginTop: '0.75rem' }}>Choose the seating before saving.</p>}
      <button className="btn btn-primary walkin-submit" disabled={!canSubmit} onClick={submit}>{submitting ? 'Saving…' : `Save booking · ${rand(total)}`}</button>
    </aside>
    {dialog}
  </div>;
}

// ── Import from the booking book ──────────────────────────────────────────

function ImportBookings() {
  const { confirm, dialog } = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'' | 'template' | 'check' | 'import'>('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [imported, setImported] = useState(false);

  const downloadTemplate = async () => {
    setBusy('template'); setError('');
    try {
      const response = await fetch('/api/admin/import-bookings', { headers: { Authorization: `Bearer ${await token()}` } });
      if (!response.ok) throw new Error('The template could not be downloaded');
      const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob()); link.download = 'graceland-booking-import-template.xlsx'; link.click(); URL.revokeObjectURL(link.href);
    } catch (downloadError) { setError(downloadError instanceof Error ? downloadError.message : 'The template could not be downloaded'); }
    finally { setBusy(''); }
  };

  const send = async (mode: 'check' | 'import') => {
    if (!file) return;
    setBusy(mode); setError('');
    try {
      const form = new FormData(); form.append('file', file); form.append('mode', mode);
      const response = await fetch('/api/admin/import-bookings', { method: 'POST', headers: { Authorization: `Bearer ${await token()}` }, body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'The file could not be processed');
      setResults(data.results);
      setImported(mode === 'import');
    } catch (sendError) { setError(sendError instanceof Error ? sendError.message : 'The file could not be processed'); }
    finally { setBusy(''); }
  };

  const ready = (results || []).filter(result => result.ok && !result.message.startsWith('Already')).length;
  const problems = (results || []).filter(result => !result.ok).length;
  const runImport = async () => {
    const answer = await confirm({ title: `Import ${ready} booking${ready === 1 ? '' : 's'}?`, message: `${ready} booking${ready === 1 ? '' : 's'} will be added as imported bookings. No tickets are emailed; the gate checks these guests in by name, phone or email.${problems ? `\n\n${problems} row${problems === 1 ? ' has a problem and is' : 's have problems and are'} skipped. Fix ${problems === 1 ? 'it' : 'them'} in the spreadsheet and import the file again later.` : ''}`, confirmLabel: 'Import' });
    if (answer.confirmed) send('import');
  };

  return <section className="card">
    <h2>Import from the booking book</h2>
    <ol style={{ margin: '0.75rem 0 1rem', paddingLeft: '1.25rem', display: 'grid', gap: 6 }}>
      <li><button type="button" className="btn btn-secondary" onClick={downloadTemplate} disabled={busy === 'template'} style={{ gap: 6, padding: '0.35rem 0.75rem' }}><DownloadIcon size={15} /> Download the template</button> and type one booking per row.</li>
      <li>Upload it and click <strong>Check file</strong>. Nothing is saved yet.</li>
      <li>Fix any rows with problems in the spreadsheet (and upload again), then click <strong>Import</strong>.</li>
    </ol>
    <div className="callout callout-info" style={{ marginBottom: '1rem' }}><p>Imported bookings are <strong>not emailed QR tickets</strong>. They are marked <strong>Imported</strong> and checked in at the gate by name, phone or email in the scanner search. They start as not paid: record any deposit or payment on each booking under <strong>All bookings</strong>.</p></div>

    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => { setFile(event.target.files?.[0] || null); setResults(null); setImported(false); }} />
      <button type="button" className="btn btn-secondary" disabled={!file || Boolean(busy)} onClick={() => send('check')}>{busy === 'check' ? 'Checking…' : 'Check file'}</button>
      {results && !imported && ready > 0 && <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={runImport}>{busy === 'import' ? 'Importing…' : `Import ${ready} booking${ready === 1 ? '' : 's'}`}</button>}
    </div>
    {error && <p role="alert" className="callout callout-danger" style={{ marginTop: '1rem' }}>{error}</p>}

    {results && <div style={{ marginTop: '1rem' }}>
      <p style={{ fontWeight: 600 }}>{imported
        ? `${results.filter(result => result.ok && result.message === 'Imported').length} imported · ${results.filter(result => result.ok && result.message !== 'Imported').length} already imported · ${problems} with problems`
        : `${ready} ready to import · ${results.filter(result => result.message.startsWith('Already')).length} already imported · ${problems} with problems`}</p>
      <div className="admin-table-wrap">
        <table className="report-table" style={{ minWidth: 620 }}>
          <thead><tr><th>Row</th><th>Customer</th><th>Date</th><th>People</th><th>Result</th></tr></thead>
          <tbody>{results.map(result => <tr key={result.row}>
            <td>{result.row}</td><td>{result.name}</td><td>{result.date}</td><td>{result.people || ''}</td>
            <td style={{ color: result.ok ? 'var(--success-text)' : 'var(--danger)' }}>{result.ok ? '✓ ' : '✗ '}{result.message}{result.reference ? ` (${result.reference})` : ''}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>}
    {dialog}
  </section>;
}
