/**
 * Business insights for the admin reports dashboard and its Excel export.
 *
 * Server-only: reads bookings, tickets, seating and vouchers with the service
 * role client. Both /api/admin/reports and /api/admin/reports/export call
 * buildReport so the dashboard and the spreadsheet always agree.
 */
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetch-all';
import { getClosedDates, applyClosure } from '@/lib/closed-dates';
import { johannesburgToday } from '@/lib/opening-rules';
import { GATE_PAYMENT_LABELS, isGateSale } from '@/lib/walk-ins';

export type ReportBasis = 'visit' | 'booked';

export const MAX_REPORT_DAYS = 1100;
const PAID = ['PAID', 'CONFIRMED'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SA_OFFSET = '+02:00'; // South Africa has no daylight saving

type Item = { quantity: number; subtotal: number; price_per_unit: number; metadata: { name?: string; itemId?: string; isPerson?: boolean; party?: boolean } | null };
type Customer = { first_name: string; last_name: string; email: string; phone: string };
type BookingRow = {
  id: string; reference: string; visit_date: string; created_at: string; status: string; payment_method: string | null;
  total_amount: number; amount_due: number | null; voucher_amount_used: number | null; people_count: number;
  party_slot: string | null; expires_at: string | null; refunded_at: string | null; voucher_issued: boolean | null;
  customers: Customer | Customer[] | null; booking_items: Item[] | null; tickets: Array<{ status: string }> | null;
};

export type Row = Record<string, string | number | null>;
export type Kpi = { label: string; value: number; format: 'currency' | 'number' | 'percent' | 'days'; previous?: number | null; hint?: string };

export type Report = {
  range: { from: string; to: string; basis: ReportBasis; days: number; previousFrom: string; previousTo: string; generatedAt: string };
  kpis: Kpi[];
  funnel: Row[];
  statusBreakdown: Row[];
  daily: Row[];
  weekly: Row[];
  monthly: Row[];
  weekdays: Row[];
  packages: Row[];
  visitorMix: Row[];
  paymentMethods: Row[];
  channels: Row[];
  parties: { summary: Row[]; slots: Row[]; options: Row[] };
  leadTime: Row[];
  bookingHours: Row[];
  peakDays: Row[];
  seating: Row[] | null;
  checkIns: Row[];
  customers: { summary: Row[]; top: Row[] };
  vouchers: Row[];
  bookings: Row[];
};

// ── Date helpers ──────────────────────────────────────────────────────────

export function isIsoDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function eachDate(from: string, to: string) {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

/** Calendar date and hour in Johannesburg for a timestamp. */
function saDateTime(timestamp: string) {
  const shifted = new Date(Date.parse(timestamp) + 2 * 3600000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours() };
}

function weekdayOf(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Monday that starts the ISO week containing date. */
function weekStart(date: string) {
  const day = weekdayOf(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

// ── Number helpers ────────────────────────────────────────────────────────

const money = (value: unknown) => Math.round(Number(value || 0) * 100) / 100;
const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const avg = (total: number, count: number) => (count > 0 ? Math.round((total / count) * 100) / 100 : 0);

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

// ── Booking classification ────────────────────────────────────────────────

function outcome(booking: Pick<BookingRow, 'status' | 'expires_at'>) {
  if (PAID.includes(booking.status)) return 'Paid';
  if (booking.status === 'CANCELLED' || booking.status === 'REFUNDED') return 'Cancelled / refunded';
  if (booking.status === 'PAYMENT_FAILED') return 'Payment failed';
  if (booking.status === 'PAYMENT_PENDING') return 'Awaiting payment';
  if (booking.status === 'UNPAID') return booking.expires_at && Date.parse(booking.expires_at) > Date.now() ? 'Awaiting payment' : 'Expired unpaid';
  return booking.status;
}

const isPaid = (booking: Pick<BookingRow, 'status'>) => PAID.includes(booking.status);
const cashCollected = (booking: BookingRow) => money(booking.amount_due ?? Number(booking.total_amount) - Number(booking.voucher_amount_used || 0));

const PAYMENT_LABELS: Record<string, string> = { PAYFAST: 'PayFast (card / instant EFT)', MANUAL_EFT: 'Manual EFT', VOUCHER: 'Voucher only', ADMIN_OVERRIDE: 'Marked paid by staff', ...GATE_PAYMENT_LABELS };

/** Age group and water option for a booking line, based on its item id or name. */
function visitorCategory(item: Item): { age: string; water: string } | null {
  const id = item.metadata?.itemId || '';
  const name = item.metadata?.name || '';
  if (!item.metadata?.isPerson) return null;
  if (id.startsWith('day-')) {
    const water = id.startsWith('day-water') ? 'Swimming' : 'Non-swimming';
    const age = id.endsWith('infant') ? 'Children under 1' : id.endsWith('toddler') ? 'Toddlers 1-2' : id.endsWith('child') ? 'Children 3-17' : id.endsWith('pensioner') ? 'Pensioners' : 'Adults';
    return { age, water };
  }
  if (/party/i.test(name)) {
    const water = /non-swimming/i.test(name) ? 'Non-swimming' : 'Swimming';
    return { age: /adult/i.test(name) ? 'Adults' : 'Children 3-17', water };
  }
  return null;
}

// ── Data loading ──────────────────────────────────────────────────────────

const BOOKING_FIELDS = 'id,reference,visit_date,created_at,status,payment_method,total_amount,amount_due,voucher_amount_used,people_count,party_slot,expires_at,refunded_at,voucher_issued,customers(first_name,last_name,email,phone),booking_items(quantity,subtotal,price_per_unit,metadata),tickets(status)';

async function loadBookings(from: string, to: string, basis: ReportBasis, fields = BOOKING_FIELDS) {
  return fetchAllRows<BookingRow>((start, end) => {
    let query = supabase.from('bookings').select(fields);
    query = basis === 'visit'
      ? query.gte('visit_date', from).lte('visit_date', to)
      : query.gte('created_at', `${from}T00:00:00${SA_OFFSET}`).lte('created_at', `${to}T23:59:59.999${SA_OFFSET}`);
    return query.order('id').range(start, end) as unknown as PromiseLike<{ data: BookingRow[] | null; error: unknown }>;
  });
}

async function loadDailyCapacity() {
  const { data } = await supabase.from('business_settings').select('daily_capacity').limit(1).maybeSingle();
  return Number(data?.daily_capacity || 500);
}

// ── Report ────────────────────────────────────────────────────────────────

export async function buildReport(from: string, to: string, basis: ReportBasis): Promise<Report> {
  const days = daysBetween(from, to);
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(days - 1));
  const today = johannesburgToday();

  const [bookings, previous, capacity, closed] = await Promise.all([
    loadBookings(from, to, basis),
    loadBookings(previousFrom, previousTo, basis, 'id,status,total_amount,amount_due,voucher_amount_used,people_count,expires_at'),
    loadDailyCapacity(),
    getClosedDates(from, to),
  ]);

  const paid = bookings.filter(isPaid);
  const previousPaid = previous.filter(isPaid);
  const dayKey = (booking: BookingRow) => (basis === 'visit' ? booking.visit_date : saDateTime(booking.created_at).date);
  const customerOf = (booking: BookingRow) => one(booking.customers);

  // ── Headline numbers ──
  const revenue = money(paid.reduce((sum, b) => sum + Number(b.total_amount), 0));
  const collected = money(paid.reduce((sum, b) => sum + cashCollected(b), 0));
  const voucherRedeemed = money(paid.reduce((sum, b) => sum + Number(b.voucher_amount_used || 0), 0));
  const visitors = paid.reduce((sum, b) => sum + Number(b.people_count || 0), 0);
  const previousRevenue = money(previousPaid.reduce((sum, b) => sum + Number(b.total_amount), 0));
  const previousVisitors = previousPaid.reduce((sum, b) => sum + Number(b.people_count || 0), 0);
  const partyBookings = paid.filter(b => b.party_slot);
  const walkIns = paid.filter(b => isGateSale(b.payment_method));
  const walkInRevenue = money(walkIns.reduce((sum, b) => sum + Number(b.total_amount), 0));
  const cancelled = bookings.filter(b => outcome(b) === 'Cancelled / refunded');

  // Check-ins only make sense once the visit date has passed.
  const pastPaid = paid.filter(b => b.visit_date < today);
  let ticketsIssued = 0; let ticketsUsed = 0; let noShowBookings = 0;
  for (const booking of pastPaid) {
    const tickets = (booking.tickets || []).filter(t => t.status !== 'CANCELLED');
    const used = tickets.filter(t => t.status === 'USED').length;
    ticketsIssued += tickets.length; ticketsUsed += used;
    if (tickets.length > 0 && used === 0) noShowBookings += 1;
  }

  const leadTimes = paid.map(b => Math.max(0, daysBetween(saDateTime(b.created_at).date, b.visit_date) - 1));
  const openDays = basis === 'visit' ? eachDate(from, to).filter(date => applyClosure(date, closed).open).length : days;

  const kpis: Kpi[] = [
    { label: 'Revenue (paid bookings)', value: revenue, format: 'currency', previous: previousRevenue, hint: 'Total value of paid bookings, including the part paid with vouchers.' },
    { label: 'Cash collected', value: collected, format: 'currency', previous: money(previousPaid.reduce((sum, b) => sum + cashCollected(b as BookingRow), 0)), hint: 'Paid by PayFast, EFT or at the desk (excludes vouchers).' },
    { label: 'Paid bookings', value: paid.length, format: 'number', previous: previousPaid.length },
    { label: 'Visitors', value: visitors, format: 'number', previous: previousVisitors },
    { label: 'Average booking value', value: avg(revenue, paid.length), format: 'currency', previous: avg(previousRevenue, previousPaid.length) },
    { label: 'Average group size', value: avg(visitors, paid.length), format: 'number', previous: avg(previousVisitors, previousPaid.length) },
    { label: 'Revenue per visitor', value: avg(revenue, visitors), format: 'currency', previous: avg(previousRevenue, previousVisitors) },
    { label: basis === 'visit' ? 'Revenue per open day' : 'Revenue per day', value: avg(revenue, openDays), format: 'currency', hint: basis === 'visit' ? `${openDays} open day${openDays === 1 ? '' : 's'} in this period.` : undefined },
    { label: 'Payment conversion', value: ratio(paid.length, bookings.length), format: 'percent', previous: ratio(previousPaid.length, previous.length), hint: 'Share of started bookings that were paid.' },
    { label: 'Check-in rate', value: ratio(ticketsUsed, ticketsIssued), format: 'percent', hint: 'Tickets scanned at the gate, for visit dates that have passed.' },
    { label: 'No-show bookings', value: noShowBookings, format: 'number', hint: 'Paid bookings for past dates where no ticket was scanned.' },
    { label: 'Party bookings', value: partyBookings.length, format: 'number' },
    { label: 'Walk-in sales', value: walkInRevenue, format: 'currency', hint: `${walkIns.length} sale${walkIns.length === 1 ? '' : 's'} at the gate, ${ratio(walkInRevenue, revenue)}% of revenue.` },
    { label: 'Vouchers redeemed', value: voucherRedeemed, format: 'currency' },
    { label: 'Cancelled / refunded', value: cancelled.length, format: 'number', hint: `R ${money(cancelled.reduce((sum, b) => sum + Number(b.total_amount), 0)).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in value.` },
    { label: 'Average days booked ahead', value: avg(leadTimes.reduce((a, b) => a + b, 0), leadTimes.length), format: 'days' },
  ];

  // ── Funnel and status ──
  const outcomes = new Map<string, { count: number; value: number; people: number }>();
  for (const booking of bookings) {
    const key = outcome(booking);
    const entry = outcomes.get(key) || { count: 0, value: 0, people: 0 };
    entry.count += 1; entry.value += Number(booking.total_amount); entry.people += Number(booking.people_count || 0);
    outcomes.set(key, entry);
  }
  const outcomeOrder = ['Paid', 'Awaiting payment', 'Expired unpaid', 'Payment failed', 'Cancelled / refunded'];
  const rank = (status: string) => (outcomeOrder.includes(status) ? outcomeOrder.indexOf(status) : outcomeOrder.length);
  const statusBreakdown = [...outcomes.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([status, entry]) => ({ Status: status, Bookings: entry.count, 'Share %': ratio(entry.count, bookings.length), People: entry.people, 'Value (R)': money(entry.value) }));
  const funnel: Row[] = [
    { Stage: 'Bookings started', Bookings: bookings.length, 'Share %': 100 },
    { Stage: 'Paid', Bookings: paid.length + cancelled.filter(b => b.voucher_issued).length, 'Share %': ratio(paid.length + cancelled.filter(b => b.voucher_issued).length, bookings.length) },
    { Stage: 'Still paid (not cancelled)', Bookings: paid.length, 'Share %': ratio(paid.length, bookings.length) },
    { Stage: 'Visited (at least one ticket scanned)', Bookings: pastPaid.length - noShowBookings, 'Share %': ratio(pastPaid.length - noShowBookings, bookings.length) },
  ];

  // ── Time series ──
  type Bucket = { bookings: number; visitors: number; revenue: number; parties: number; checkedIn: number; started: number };
  const emptyBucket = (): Bucket => ({ bookings: 0, visitors: 0, revenue: 0, parties: 0, checkedIn: 0, started: 0 });
  const byDay = new Map<string, Bucket>();
  for (const booking of bookings) {
    const bucket = byDay.get(dayKey(booking)) || emptyBucket();
    bucket.started += 1;
    if (isPaid(booking)) {
      bucket.bookings += 1;
      bucket.visitors += Number(booking.people_count || 0);
      bucket.revenue += Number(booking.total_amount);
      if (booking.party_slot) bucket.parties += 1;
      bucket.checkedIn += (booking.tickets || []).filter(t => t.status === 'USED').length;
    }
    byDay.set(dayKey(booking), bucket);
  }
  const daily = eachDate(from, to).map(date => {
    const bucket = byDay.get(date) || emptyBucket();
    const status = applyClosure(date, closed);
    return {
      Date: date,
      Weekday: WEEKDAYS[weekdayOf(date)],
      ...(basis === 'visit' ? { Open: status.open ? 'Yes' : closed.has(date) ? 'Closed by staff' : 'No' } : {}),
      'Bookings started': bucket.started,
      'Paid bookings': bucket.bookings,
      Visitors: bucket.visitors,
      'Revenue (R)': money(bucket.revenue),
      'Party bookings': bucket.parties,
      ...(basis === 'visit' ? { 'Tickets scanned': bucket.checkedIn, 'Capacity used %': ratio(bucket.visitors, capacity) } : {}),
    };
  });

  const rollup = (keyOf: (date: string) => string, label: string) => {
    const map = new Map<string, Bucket & { days: number }>();
    for (const row of daily) {
      const key = keyOf(String(row.Date));
      const entry = map.get(key) || { ...emptyBucket(), days: 0 };
      entry.bookings += Number(row['Paid bookings']); entry.visitors += Number(row.Visitors); entry.revenue += Number(row['Revenue (R)']);
      entry.parties += Number(row['Party bookings']); entry.started += Number(row['Bookings started']);
      if (basis !== 'visit' || row.Open === 'Yes') entry.days += 1;
      map.set(key, entry);
    }
    return [...map.entries()].map(([key, entry]) => ({
      [label]: key,
      'Paid bookings': entry.bookings,
      Visitors: entry.visitors,
      'Revenue (R)': money(entry.revenue),
      'Average booking (R)': avg(entry.revenue, entry.bookings),
      'Party bookings': entry.parties,
      ...(basis === 'visit' ? { 'Open days': entry.days } : {}),
    }));
  };
  const weekly = rollup(weekStart, 'Week starting');
  const monthly = rollup(date => date.slice(0, 7), 'Month');

  const weekdayTotals = WEEKDAYS.map(() => ({ ...emptyBucket(), days: 0 }));
  for (const row of daily) {
    const entry = weekdayTotals[weekdayOf(String(row.Date))];
    entry.bookings += Number(row['Paid bookings']); entry.visitors += Number(row.Visitors); entry.revenue += Number(row['Revenue (R)']);
    if (basis !== 'visit' || row.Open === 'Yes') entry.days += 1;
  }
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const weekdays = weekdayOrder.map(index => {
    const entry = weekdayTotals[index];
    return {
      Weekday: WEEKDAYS[index],
      [basis === 'visit' ? 'Open days' : 'Days']: entry.days,
      'Paid bookings': entry.bookings,
      Visitors: entry.visitors,
      'Revenue (R)': money(entry.revenue),
      [basis === 'visit' ? 'Avg visitors per open day' : 'Avg visitors per day']: avg(entry.visitors, entry.days),
      [basis === 'visit' ? 'Avg revenue per open day (R)' : 'Avg revenue per day (R)']: avg(entry.revenue, entry.days),
    };
  });

  // ── What sold ──
  const packages = new Map<string, { units: number; revenue: number; bookings: number }>();
  const ageMix = new Map<string, number>();
  const waterMix = new Map<string, number>();
  for (const booking of paid) {
    const seen = new Set<string>();
    for (const item of booking.booking_items || []) {
      const name = item.metadata?.name || 'Other';
      if (name === 'Birthday party child entrance') continue; // free ticket that mirrors the party package line
      const entry = packages.get(name) || { units: 0, revenue: 0, bookings: 0 };
      entry.units += Number(item.quantity || 0); entry.revenue += Number(item.subtotal || 0);
      if (!seen.has(name)) { entry.bookings += 1; seen.add(name); }
      packages.set(name, entry);
      const category = visitorCategory(item);
      if (category) {
        ageMix.set(category.age, (ageMix.get(category.age) || 0) + Number(item.quantity || 0));
        waterMix.set(category.water, (waterMix.get(category.water) || 0) + Number(item.quantity || 0));
      }
      if (/^Kiddy Party/.test(name)) ageMix.set('Children 3-17', (ageMix.get('Children 3-17') || 0) + Number(item.quantity || 0));
      if (/^Kiddy Party/.test(name)) waterMix.set('Swimming', (waterMix.get('Swimming') || 0) + Number(item.quantity || 0));
    }
  }
  const itemRevenue = [...packages.values()].reduce((sum, entry) => sum + entry.revenue, 0);
  const packageRows = [...packages.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue || b[1].units - a[1].units)
    .map(([name, entry]) => ({ Item: name, 'Units sold': entry.units, 'Bookings with item': entry.bookings, 'Revenue (R)': money(entry.revenue), 'Share of revenue %': ratio(entry.revenue, itemRevenue), 'Average price (R)': avg(entry.revenue, entry.units) }));
  const mixTotal = [...ageMix.values()].reduce((a, b) => a + b, 0);
  const waterTotal = [...waterMix.values()].reduce((a, b) => a + b, 0);
  const ageOrder = ['Adults', 'Pensioners', 'Children 3-17', 'Toddlers 1-2', 'Children under 1'];
  const visitorMix: Row[] = [
    ...ageOrder.filter(age => ageMix.has(age)).map(age => ({ Group: 'Age', Category: age, Visitors: ageMix.get(age) || 0, 'Share %': ratio(ageMix.get(age) || 0, mixTotal) })),
    ...['Swimming', 'Non-swimming'].filter(water => waterMix.has(water)).map(water => ({ Group: 'Water activities', Category: water, Visitors: waterMix.get(water) || 0, 'Share %': ratio(waterMix.get(water) || 0, waterTotal) })),
  ];

  // ── Payment methods ──
  const methods = new Map<string, { bookings: number; revenue: number; collected: number }>();
  for (const booking of paid) {
    const key = PAYMENT_LABELS[booking.payment_method || ''] || booking.payment_method || 'Not recorded';
    const entry = methods.get(key) || { bookings: 0, revenue: 0, collected: 0 };
    entry.bookings += 1; entry.revenue += Number(booking.total_amount); entry.collected += cashCollected(booking);
    methods.set(key, entry);
  }
  const paymentMethods = [...methods.entries()].sort((a, b) => b[1].revenue - a[1].revenue).map(([method, entry]) => ({ Method: method, Bookings: entry.bookings, 'Share %': ratio(entry.bookings, paid.length), 'Booking value (R)': money(entry.revenue), 'Cash collected (R)': money(entry.collected) }));

  // ── Sales channel ──
  const online = paid.filter(b => !isGateSale(b.payment_method));
  const channels = ([['Online bookings', online], ['Walk-in (gate) sales', walkIns]] as const).map(([channel, rows]) => {
    const value = rows.reduce((sum, b) => sum + Number(b.total_amount), 0);
    const guests = rows.reduce((sum, b) => sum + Number(b.people_count || 0), 0);
    return { Channel: channel, 'Paid bookings': rows.length, Visitors: guests, 'Revenue (R)': money(value), 'Share of revenue %': ratio(value, revenue), 'Average sale (R)': avg(value, rows.length) };
  });

  // ── Parties ──
  const slotMap = new Map<string, { bookings: number; revenue: number; children: number }>();
  const optionMap = new Map<string, { bookings: number; revenue: number; children: number }>();
  let partyChildren = 0; let partyGuests = 0; let partyRevenue = 0; let partyPacks = 0;
  for (const booking of partyBookings) {
    const items = booking.booking_items || [];
    const packageLine = items.find(item => /^Kiddy Party/.test(item.metadata?.name || ''));
    const children = Number(packageLine?.quantity || 0);
    const value = Number(booking.total_amount);
    partyChildren += children; partyGuests += Number(booking.people_count || 0); partyRevenue += value;
    partyPacks += items.filter(item => item.metadata?.name === 'Optional party pack').reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const slot = booking.party_slot || 'Unknown';
    const option = /Option 2/.test(packageLine?.metadata?.name || '') ? 'Option 2 (with hotdog)' : 'Option 1';
    for (const [map, key] of [[slotMap, slot], [optionMap, option]] as const) {
      const entry = map.get(key) || { bookings: 0, revenue: 0, children: 0 };
      entry.bookings += 1; entry.revenue += value; entry.children += children;
      map.set(key, entry);
    }
  }
  const partyRows = (map: typeof slotMap, label: string) => [...map.entries()].sort((a, b) => b[1].bookings - a[1].bookings).map(([key, entry]) => ({ [label]: key, Parties: entry.bookings, 'Party children': entry.children, 'Revenue (R)': money(entry.revenue), 'Average party (R)': avg(entry.revenue, entry.bookings) }));
  const parties = {
    summary: [
      { Measure: 'Party bookings', Value: partyBookings.length },
      { Measure: 'Share of paid bookings %', Value: ratio(partyBookings.length, paid.length) },
      { Measure: 'Party revenue (R)', Value: money(partyRevenue) },
      { Measure: 'Share of revenue %', Value: ratio(partyRevenue, revenue) },
      { Measure: 'Average party value (R)', Value: avg(partyRevenue, partyBookings.length) },
      { Measure: 'Average party children', Value: avg(partyChildren, partyBookings.length) },
      { Measure: 'Average guests per party (incl. adults)', Value: avg(partyGuests, partyBookings.length) },
      { Measure: 'Party packs sold', Value: partyPacks },
    ],
    slots: partyRows(slotMap, 'Time slot'),
    options: partyRows(optionMap, 'Package'),
  };

  // ── Booking behaviour ──
  const leadBuckets: Array<[string, number, number]> = [['Same day', 0, 0], ['1 day ahead', 1, 1], ['2-3 days ahead', 2, 3], ['4-7 days ahead', 4, 7], ['8-14 days ahead', 8, 14], ['15-30 days ahead', 15, 30], ['More than 30 days ahead', 31, Infinity]];
  const leadTime = leadBuckets.map(([label, min, max]) => {
    const matches = paid.filter((_, index) => leadTimes[index] >= min && leadTimes[index] <= max);
    return { 'Booked': label, 'Paid bookings': matches.length, 'Share %': ratio(matches.length, paid.length), 'Revenue (R)': money(matches.reduce((sum, b) => sum + Number(b.total_amount), 0)) };
  });

  const hours = Array.from({ length: 24 }, () => ({ started: 0, paid: 0 }));
  for (const booking of bookings) {
    const { hour } = saDateTime(booking.created_at);
    hours[hour].started += 1;
    if (isPaid(booking)) hours[hour].paid += 1;
  }
  const bookingHours = hours.map((entry, hour) => ({ Hour: `${String(hour).padStart(2, '0')}:00`, 'Bookings started': entry.started, 'Paid bookings': entry.paid, 'Share of paid %': ratio(entry.paid, paid.length) }));

  const peakDays = [...daily].filter(row => Number(row.Visitors) > 0).sort((a, b) => Number(b.Visitors) - Number(a.Visitors)).slice(0, 15)
    .map(row => ({ Date: row.Date, Weekday: row.Weekday, Visitors: row.Visitors, 'Paid bookings': row['Paid bookings'], 'Revenue (R)': row['Revenue (R)'], ...(basis === 'visit' ? { 'Capacity used %': row['Capacity used %'] } : {}) }));

  // ── Check-ins by visit date ──
  const checkInMap = new Map<string, { bookings: number; issued: number; used: number; noShows: number }>();
  for (const booking of pastPaid) {
    const tickets = (booking.tickets || []).filter(t => t.status !== 'CANCELLED');
    const used = tickets.filter(t => t.status === 'USED').length;
    const entry = checkInMap.get(booking.visit_date) || { bookings: 0, issued: 0, used: 0, noShows: 0 };
    entry.bookings += 1; entry.issued += tickets.length; entry.used += used;
    if (tickets.length > 0 && used === 0) entry.noShows += 1;
    checkInMap.set(booking.visit_date, entry);
  }
  const checkIns = [...checkInMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, entry]) => ({ 'Visit date': date, 'Paid bookings': entry.bookings, 'Tickets issued': entry.issued, 'Tickets scanned': entry.used, 'Check-in rate %': ratio(entry.used, entry.issued), 'No-show bookings': entry.noShows }));

  // ── Seating (visit-date reports only) ──
  let seating: Row[] | null = null;
  if (basis === 'visit') {
    const [spots, reservations] = await Promise.all([
      supabase.from('venue_spots').select('id,type'),
      fetchAllRows<{ id: string; spot_id: string; bookings: { status: string } | { status: string }[] | null }>((start, end) => supabase
        .from('booking_spots').select('id,spot_id,bookings!inner(status)').gte('visit_date', from).lte('visit_date', to).in('bookings.status', PAID).order('id').range(start, end) as unknown as PromiseLike<{ data: Array<{ id: string; spot_id: string; bookings: { status: string } | null }> | null; error: unknown }>),
    ]);
    if (spots.error) throw spots.error;
    const typeOf = new Map((spots.data || []).map(spot => [spot.id, spot.type as string]));
    seating = (['hut', 'table'] as const).map(type => {
      const total = (spots.data || []).filter(spot => spot.type === type).length;
      const booked = reservations.filter(row => typeOf.get(row.spot_id) === type).length;
      return { Seating: type === 'hut' ? 'Covered huts' : 'Shaded tables', 'Spots available': total, 'Spot-days booked': booked, 'Avg booked per open day': avg(booked, openDays), 'Utilisation %': ratio(booked, total * openDays) };
    });
  }

  // ── Customers ──
  const customerMap = new Map<string, { name: string; email: string; phone: string; bookings: number; visitors: number; spend: number; first: string; last: string }>();
  for (const booking of paid) {
    const customer = customerOf(booking);
    const email = (customer?.email || '').toLowerCase();
    if (!email) continue;
    const entry = customerMap.get(email) || { name: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim(), email, phone: customer?.phone || '', bookings: 0, visitors: 0, spend: 0, first: booking.visit_date, last: booking.visit_date };
    entry.bookings += 1; entry.visitors += Number(booking.people_count || 0); entry.spend += Number(booking.total_amount);
    if (booking.visit_date < entry.first) entry.first = booking.visit_date;
    if (booking.visit_date > entry.last) entry.last = booking.visit_date;
    customerMap.set(email, entry);
  }
  // Returning customers: paid for a booking before this period started.
  const earlier = await fetchAllRows<{ id: string; customers: { email: string } | { email: string }[] | null }>((start, end) => {
    let query = supabase.from('bookings').select('id,customers!inner(email)').in('status', PAID);
    query = basis === 'visit' ? query.lt('visit_date', from) : query.lt('created_at', `${from}T00:00:00${SA_OFFSET}`);
    return query.order('id').range(start, end) as unknown as PromiseLike<{ data: Array<{ id: string; customers: { email: string } | null }> | null; error: unknown }>;
  });
  const earlierEmails = new Set(earlier.map(row => (one(row.customers)?.email || '').toLowerCase()).filter(Boolean));
  const uniqueCustomers = customerMap.size;
  const repeatInPeriod = [...customerMap.values()].filter(entry => entry.bookings > 1).length;
  const returning = [...customerMap.keys()].filter(email => earlierEmails.has(email)).length;
  const customers = {
    summary: [
      { Measure: 'Unique paying customers', Value: uniqueCustomers },
      { Measure: 'New customers', Value: uniqueCustomers - returning },
      { Measure: 'Returning customers (booked before this period)', Value: returning },
      { Measure: 'Returning share %', Value: ratio(returning, uniqueCustomers) },
      { Measure: 'Customers with more than one booking in this period', Value: repeatInPeriod },
      { Measure: 'Average spend per customer (R)', Value: avg(revenue, uniqueCustomers) },
    ],
    top: [...customerMap.values()].sort((a, b) => b.spend - a.spend).slice(0, 25).map(entry => ({ Customer: entry.name || entry.email, Email: entry.email, Phone: entry.phone, Bookings: entry.bookings, Visitors: entry.visitors, 'Spend (R)': money(entry.spend), 'First visit': entry.first, 'Last visit': entry.last, Returning: earlierEmails.has(entry.email) ? 'Yes' : 'No' })),
  };

  // ── Vouchers (always by the date the voucher activity happened) ──
  const fromTs = `${from}T00:00:00${SA_OFFSET}`; const toTs = `${to}T23:59:59.999${SA_OFFSET}`;
  const [issued, redemptions, outstanding] = await Promise.all([
    fetchAllRows<{ id: string; original_amount: number; status: string }>((start, end) => supabase.from('booking_credits').select('id,original_amount,status').gte('created_at', fromTs).lte('created_at', toTs).order('id').range(start, end) as unknown as PromiseLike<{ data: Array<{ id: string; original_amount: number; status: string }> | null; error: unknown }>),
    fetchAllRows<{ id: string; amount_used: number; released: boolean | null }>((start, end) => supabase.from('credit_redemptions').select('id,amount_used,released').gte('created_at', fromTs).lte('created_at', toTs).order('id').range(start, end) as unknown as PromiseLike<{ data: Array<{ id: string; amount_used: number; released: boolean | null }> | null; error: unknown }>),
    fetchAllRows<{ id: string; remaining_balance: number }>((start, end) => supabase.from('booking_credits').select('id,remaining_balance').eq('status', 'active').order('id').range(start, end) as unknown as PromiseLike<{ data: Array<{ id: string; remaining_balance: number }> | null; error: unknown }>),
  ]);
  const activeRedemptions = redemptions.filter(row => !row.released);
  const vouchers: Row[] = [
    { Measure: 'Vouchers issued in period', Count: issued.length, 'Value (R)': money(issued.reduce((sum, row) => sum + Number(row.original_amount), 0)) },
    { Measure: 'Vouchers voided (of those issued)', Count: issued.filter(row => row.status === 'void').length, 'Value (R)': money(issued.filter(row => row.status === 'void').reduce((sum, row) => sum + Number(row.original_amount), 0)) },
    { Measure: 'Voucher redemptions in period', Count: activeRedemptions.length, 'Value (R)': money(activeRedemptions.reduce((sum, row) => sum + Number(row.amount_used), 0)) },
    { Measure: 'Outstanding voucher balance today (all time)', Count: outstanding.length, 'Value (R)': money(outstanding.reduce((sum, row) => sum + Number(row.remaining_balance), 0)) },
  ];

  // ── Raw bookings ──
  const bookingRows = [...bookings].sort((a, b) => a.visit_date.localeCompare(b.visit_date) || a.created_at.localeCompare(b.created_at)).map(booking => {
    const customer = customerOf(booking);
    const tickets = booking.tickets || [];
    return {
      Reference: booking.reference,
      'Visit date': booking.visit_date,
      'Booked on': saDateTime(booking.created_at).date,
      Status: outcome(booking),
      'Payment method': PAYMENT_LABELS[booking.payment_method || ''] || booking.payment_method || '',
      Customer: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim(),
      Email: customer?.email || '',
      Phone: customer?.phone || '',
      People: Number(booking.people_count || 0),
      'Total (R)': money(booking.total_amount),
      'Voucher used (R)': money(booking.voucher_amount_used),
      'Cash collected (R)': isPaid(booking) ? cashCollected(booking) : 0,
      Party: booking.party_slot ? `Yes (${booking.party_slot})` : 'No',
      Items: (booking.booking_items || []).filter(item => Number(item.subtotal) > 0 || item.metadata?.isPerson).map(item => `${item.quantity}× ${item.metadata?.name || 'Item'}`).join('; '),
      'Tickets scanned': `${tickets.filter(t => t.status === 'USED').length}/${tickets.filter(t => t.status !== 'CANCELLED').length}`,
    };
  });

  return {
    range: { from, to, basis, days, previousFrom, previousTo, generatedAt: new Date().toISOString() },
    kpis,
    funnel,
    statusBreakdown,
    daily, weekly, monthly, weekdays,
    packages: packageRows,
    visitorMix,
    paymentMethods,
    channels,
    parties,
    leadTime,
    bookingHours,
    peakDays,
    seating,
    checkIns,
    customers,
    vouchers,
    bookings: bookingRows,
  };
}
