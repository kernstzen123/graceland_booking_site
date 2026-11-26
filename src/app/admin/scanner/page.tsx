'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { johannesburgToday } from '@/lib/opening-rules';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { CameraScanner } from '@/components/CameraScanner';
import { checkInBlocker, type BookingCard } from '@/lib/booking-card';
import { classifyScan, createScanBuffer } from '@/lib/handheld-scanner';
import {
  initDB,
  searchTickets,
  syncTicketsFromServer,
  pushSyncQueue,
  getSyncStatus,
  getDeviceId,
  cacheSession,
  getCachedSession,
  getMeta,
  lookupBookingLocally,
  checkInBookingLocally,
  markTicketsUsedLocally,
  type OfflineTicket,
  type SyncStatus,
} from '@/lib/offline-db';
import { playSuccess, playDuplicate, playError, playClick, warmUpAudio } from '@/lib/scanner-audio';

/**
 * The gate scanner. Customers have one QR code per booking: scanning it (or an
 * older per-person ticket code, a ticket ID or a booking reference) shows the
 * booking card — passes, hut or table, names, total and whether it is paid —
 * and staff check in the whole group or part of it. The handheld (keyboard)
 * scanner is the default; the camera is a backup. Works offline from the day's
 * synced copy, and meal vouchers are redeemed as before.
 */

type Mode = 'handheld' | 'camera';
type Outcome = { ok: boolean; text: string };
type CardView = { kind: 'card'; card: BookingCard; lastCheckInAt: string | null; offline: boolean; count: number; outcome?: Outcome };
type NoticeView = { kind: 'notice'; tone: 'success' | 'warning' | 'error'; title: string; detail?: string };
type View = { kind: 'idle' } | CardView | NoticeView;

const MODE_KEY = 'graceland_scanner_mode';
const DOWNLOAD_EVERY_MS = 5 * 60 * 1000;
const NOTICE_MS = 4000;
const AFTER_CHECK_IN_MS = 3500;

const rands = (value: number) => `R ${value.toFixed(2)}`;
const shortDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function formatTime(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What to send the server for a scanned or typed code. */
function lookupBody(code: string) {
  const value = code.trim();
  if (/^BK-/i.test(value)) return { reference: value };
  if (/^(TKT|MEAL)-/i.test(value)) return { ticketUid: value };
  return { token: value };
}

/** A fetch that failed because there is no connection (not because the server said no). */
const isNetworkError = (error: unknown) => error instanceof TypeError;

export default function Scanner() {
  const [mode, setMode] = useState<Mode>('handheld');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const viewRef = useRef<View>(view);
  const [message, setMessage] = useState('Ready to scan');
  const [checkedInCount, setCheckedInCount] = useState(0);
  const [queued, setQueued] = useState(0);
  const queue = useRef<string[]>([]);
  const busy = useRef(false);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanBuffer = useRef(createScanBuffer());
  const [focusLost, setFocusLost] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<OfflineTicket[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  // Online / offline & sync
  const [isOnline, setIsOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ lastSync: null, ticketCount: 0, pendingCount: 0 });
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const authToken = useRef<string | null>(null);

  useEffect(() => { viewRef.current = view; }, [view]);

  // ── Auth & sync ─────────────────────────────────────────────────────────

  const getAuthToken = useCallback(async (): Promise<string | null> => {
    if (authToken.current) return authToken.current;
    try {
      const session = (await supabaseBrowser.auth.getSession()).data.session;
      if (session) {
        authToken.current = session.access_token;
        return session.access_token;
      }
    } catch { /* offline */ }
    const cached = await getCachedSession();
    if (cached) {
      authToken.current = cached.access_token;
      return cached.access_token;
    }
    return null;
  }, []);

  const refreshSyncStatus = useCallback(async () => {
    try { setSyncStatus(await getSyncStatus()); } catch { /* IDB not ready yet */ }
  }, []);

  /** Send check-ins made offline to the server. */
  const attemptSync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    const token = await getAuthToken();
    if (!token) return;
    try {
      syncingRef.current = true;
      setSyncing(true);
      if ((await getSyncStatus()).pendingCount === 0) return;
      await pushSyncQueue(token);
      await refreshSyncStatus();
    } catch (err) {
      console.warn('Sync attempt failed:', err);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [getAuthToken, refreshSyncStatus]);

  /** Send offline check-ins, then download today's bookings and tickets. `quiet` keeps the status line as it is. */
  const syncNow = useCallback(async (quiet = false) => {
    if (syncingRef.current) return;
    const token = await getAuthToken();
    if (!token) {
      if (!quiet) setMessage('No staff session: please sign in');
      return;
    }
    try {
      syncingRef.current = true;
      setSyncing(true);
      if (!quiet) setMessage('Syncing today’s bookings…');
      await pushSyncQueue(token).catch(() => {});
      const result = await syncTicketsFromServer(token);
      await refreshSyncStatus();
      if (!quiet) setMessage(`Synced ${result.count} tickets at ${formatTime(result.synced_at)}`);
    } catch (err) {
      if (!quiet) setMessage(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [getAuthToken, refreshSyncStatus]);

  // ── Showing results ─────────────────────────────────────────────────────

  const clearViewTimer = () => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = null;
  };

  // Declared before use by the timers below; assigned once processCode exists.
  const pumpRef = useRef<() => void>(() => {});

  const showIdle = useCallback(() => {
    clearViewTimer();
    viewRef.current = { kind: 'idle' };
    setView({ kind: 'idle' });
    setMessage('Ready to scan');
    // The next waiting scan, if any, once this one is finished.
    setTimeout(() => pumpRef.current(), 0);
  }, []);

  const showNotice = useCallback((notice: Omit<NoticeView, 'kind'>) => {
    clearViewTimer();
    const next: NoticeView = { kind: 'notice', ...notice };
    viewRef.current = next;
    setView(next);
    setMessage(notice.title);
    viewTimer.current = setTimeout(showIdle, NOTICE_MS);
  }, [showIdle]);

  const showCard = useCallback((card: BookingCard, lastCheckInAt: string | null, offline: boolean, outcome?: Outcome) => {
    clearViewTimer();
    const remaining = Math.max(0, card.people - card.checkedIn);
    const next: CardView = { kind: 'card', card, lastCheckInAt, offline, count: Math.max(1, remaining), outcome };
    viewRef.current = next;
    setView(next);
  }, []);

  // ── Meal vouchers (unchanged: redeemed online at the kitchen) ────────────

  const redeemMeal = useCallback(async (code: string) => {
    if (!navigator.onLine) {
      playError();
      showNotice({ tone: 'error', title: 'Offline', detail: 'Meal vouchers need an internet connection to scan.' });
      return;
    }
    const token = await getAuthToken();
    if (!token) throw new Error('Your staff session has expired');
    let value = code.trim();
    try { value = new URL(value).searchParams.get('token') || value; } catch { /* not a URL */ }
    const response = await fetch('/api/admin/meals/redeem', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
    });
    const data = await response.json();
    const alreadyRedeemed = !data.success && data.status === 'REDEEMED';
    if (data.success) playSuccess(); else if (alreadyRedeemed) playDuplicate(); else playError();
    showNotice({
      tone: data.success ? 'success' : alreadyRedeemed ? 'warning' : 'error',
      title: data.success ? 'MEAL REDEEMED' : alreadyRedeemed ? 'MEAL ALREADY REDEEMED' : 'MEAL VOUCHER REJECTED',
      detail: data.success ? data.details?.meal_name || 'Meal voucher' : data.error || data.message,
    });
  }, [getAuthToken, showNotice]);

  // ── Bookings ─────────────────────────────────────────────────────────────

  /** Find the booking behind a code (server first when online, else this device's copy) and show its card. */
  const openBooking = useCallback(async (code: string) => {
    let card: BookingCard | null = null;
    let lastCheckInAt: string | null = null;
    let offline = false;
    let refusal: string | null = null;
    if (navigator.onLine) {
      try {
        const token = await getAuthToken();
        if (!token) throw new Error('Your staff session has expired');
        const response = await fetch('/api/admin/scan/lookup', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(lookupBody(code)),
        });
        const data = await response.json();
        if (data.mealUid) return redeemMeal(code);
        if (data.success) { card = data.booking; lastCheckInAt = data.lastCheckInAt || null; }
        else if (response.status < 500 && response.status !== 429) refusal = data.error || 'Booking not found.';
      } catch (error) {
        if (!isNetworkError(error) && error instanceof Error && error.message.includes('session')) refusal = error.message;
      }
    }
    if (!card && !refusal) {
      const local = await lookupBookingLocally(code);
      if (local) { card = local; offline = true; }
    }
    if (!card) {
      playError();
      showNotice({ tone: 'error', title: 'NOT FOUND', detail: refusal || (navigator.onLine ? 'Booking not found.' : 'Not found on this device. Sync when you are back online.') });
      return;
    }
    const blocker = checkInBlocker(card, johannesburgToday());
    if (blocker && card.people > 0 && card.checkedIn >= card.people) playDuplicate();
    else if (blocker) playError();
    else playClick();
    setMessage(blocker || `${card.customerName}: ${card.people - card.checkedIn} to check in`);
    showCard(card, lastCheckInAt, offline);
  }, [getAuthToken, redeemMeal, showCard, showNotice]);

  /** Handle one scanned or typed value. */
  const processCode = useCallback(async (value: string) => {
    busy.current = true;
    warmUpAudio();
    setMessage('Checking…');
    try {
      const kind = classifyScan(value);
      if (kind === 'garbled') {
        playError();
        showNotice({ tone: 'error', title: 'SCAN NOT RECOGNISED', detail: 'Scan again. If this keeps happening with the handheld scanner, set both the scanner and the tablet keyboard (Settings → Languages & input → Physical keyboard) to English (US).' });
      } else if (kind === 'meal') {
        await redeemMeal(value);
      } else {
        await openBooking(value);
      }
    } catch (error) {
      playError();
      showNotice({ tone: 'error', title: 'COULD NOT CHECK', detail: error instanceof Error ? error.message : 'Could not process the scan.' });
    } finally {
      busy.current = false;
    }
  }, [openBooking, redeemMeal, showNotice]);

  // Scans wait their turn: the next one is handled once the booking on screen is checked in or closed.
  const pump = useCallback(() => {
    if (busy.current || viewRef.current.kind === 'card') return;
    const next = queue.current.shift();
    setQueued(queue.current.length);
    if (next) processCode(next);
  }, [processCode]);
  useEffect(() => { pumpRef.current = pump; }, [pump]);

  const enqueue = useCallback((value: string) => {
    if (!value.trim()) return;
    // A notice (e.g. the last meal redeemed) gives way to the next scan straight away.
    if (viewRef.current.kind === 'notice') {
      clearViewTimer();
      viewRef.current = { kind: 'idle' };
      setView({ kind: 'idle' });
    }
    queue.current.push(value);
    setQueued(queue.current.length);
    pumpRef.current();
  }, []);

  /** Check in `count` people on the booking on screen (online when possible, else on this device for syncing later). */
  const checkIn = useCallback(async (count: number) => {
    const current = viewRef.current;
    if (current.kind !== 'card' || busy.current) return;
    busy.current = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const deviceId = getDeviceId();
    const { card } = current;
    try {
      let handled = false;
      if (navigator.onLine) {
        try {
          const token = await getAuthToken();
          if (!token) throw new Error('Your staff session has expired');
          const response = await fetch('/api/admin/scan/checkin', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookingId: card.bookingId, count, deviceId }),
          });
          // From here the server answered: whatever it said, this device must not also check in on its own.
          handled = true;
          const data = await response.json().catch(() => ({ success: false, error: `The server could not check in this booking (${response.status}). Try again.` }));
          const updated: BookingCard = data.booking || card;
          if (data.success) {
            await markTicketsUsedLocally(data.checkedIn || [], deviceId);
            const n = (data.checkedIn || []).length;
            playSuccess();
            setCheckedInCount(total => total + n);
            setMessage(`Checked in ${n}`);
            showCard(updated, data.lastCheckInAt || null, false, { ok: true, text: `✓ Checked in ${n} ${n === 1 ? 'person' : 'people'} · ${updated.checkedIn} of ${updated.people} now in` });
            viewTimer.current = setTimeout(showIdle, AFTER_CHECK_IN_MS);
          } else {
            playError();
            showCard(updated, data.lastCheckInAt || current.lastCheckInAt, false, { ok: false, text: data.error || 'Could not check in this booking.' });
          }
        } catch (error) {
          if (!isNetworkError(error)) throw error;
        }
      }
      if (!handled) {
        const result = await checkInBookingLocally(card.bookingId, count, deviceId);
        if (result.success) {
          const n = result.checkedIn.length;
          const updated = result.booking || card;
          playSuccess();
          setCheckedInCount(total => total + n);
          setMessage(`Checked in ${n} (offline)`);
          showCard(updated, new Date().toISOString(), true, { ok: true, text: `✓ Checked in ${n} ${n === 1 ? 'person' : 'people'} offline · ${updated.checkedIn} of ${updated.people} now in · will sync when connected` });
          viewTimer.current = setTimeout(showIdle, AFTER_CHECK_IN_MS);
          await refreshSyncStatus();
          if (navigator.onLine) setTimeout(() => attemptSync(), 500);
        } else {
          playError();
          showCard(result.booking || card, current.lastCheckInAt, true, { ok: false, text: result.error || 'Could not check in this booking.' });
        }
      }
    } catch (error) {
      playError();
      showCard(card, current.lastCheckInAt, current.offline, { ok: false, text: error instanceof Error ? error.message : 'Could not check in this booking.' });
    } finally {
      busy.current = false;
    }
  }, [attemptSync, getAuthToken, refreshSyncStatus, showCard, showIdle]);

  const setCount = (count: number) => setView(current => {
    if (current.kind !== 'card') return current;
    const next = { ...current, count };
    viewRef.current = next;
    return next;
  });

  // ── Handheld scanner (keyboard input) ───────────────────────────────────

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Typing in the search box is ordinary typing, not a scan.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const now = performance.now();
      const wasScanning = scanBuffer.current.active(now);
      const scanned = scanBuffer.current.key(event.key, now);
      if (scanned) {
        // The scanner's Enter must never press a button that has focus (e.g. "Check in").
        event.preventDefault();
        event.stopPropagation();
        enqueue(scanned);
        return;
      }
      if (wasScanning && (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key.length === 1 && target?.tagName === 'BUTTON') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enqueue]);

  // Focus guard: the handheld scanner types into the page, so it only works while the page has focus.
  useEffect(() => {
    const onBlur = () => setFocusLost(true);
    const onFocus = () => setFocusLost(false);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reading the browser's focus once on mount; not derived state.
    setFocusLost(!document.hasFocus());
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Keep the screen on while the scanner page is open.
  useEffect(() => {
    type WakeLock = { release: () => Promise<void> };
    const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLock> } }).wakeLock;
    if (!wakeLockApi) return;
    let lock: WakeLock | null = null;
    let cancelled = false;
    const request = () => {
      if (document.visibilityState !== 'visible') return;
      wakeLockApi.request('screen').then(next => { if (cancelled) next.release(); else lock = next; }).catch(() => { /* not allowed (e.g. low battery) */ });
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', request);
      lock?.release().catch(() => {});
    };
  }, []);

  // Remember the chosen mode on this device; the handheld scanner is the default.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reading this device's saved choice once on mount.
      if (localStorage.getItem(MODE_KEY) === 'camera') setMode('camera');
    } catch { /* storage unavailable */ }
  }, []);
  const chooseMode = (next: Mode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* storage unavailable */ }
    setMessage(next === 'camera' ? 'Point the camera at the booking QR code' : 'Ready to scan');
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  // ── Search ───────────────────────────────────────────────────────────────

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await searchTickets(query, 40);
      if (navigator.onLine) {
        try {
          const searchToken = await getAuthToken();
          const res = await fetch(`/api/admin/meals/search?q=${encodeURIComponent(query)}`, { headers: searchToken ? { Authorization: `Bearer ${searchToken}` } : {} });
          if (res.ok) {
            const data = await res.json();
            type MealSearchResult = { id: string; meal_uid: string; booking_ref?: string; customer_name?: string; meal_name?: string; special_title?: string; email?: string; visit_date: string; redeemed: boolean; redeemed_at: string | null };
            results.push(...(data.meals as MealSearchResult[]).map(m => ({
              ticket_uid: m.meal_uid, booking_id: '', booking_ref: m.booking_ref || 'N/A', ticket_id: m.id, seating: '', qr_token: '', checked_in_by_device: null,
              customer_name: m.customer_name || 'Meal Voucher', package_name: m.meal_name || m.special_title || 'Meal Voucher', email: m.email, visit_date: m.visit_date,
              status: (m.redeemed ? 'USED' : 'VALID') as OfflineTicket['status'], checked_in_at: m.redeemed_at, isMeal: true,
            })));
          }
        } catch { /* ignore online search errors */ }
      }
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
  }, [getAuthToken]);

  /** One search row per booking (its tickets grouped), and meal vouchers on their own. */
  const searchRows = (() => {
    const rows: Array<{ key: string; open: string; ticket: OfflineTicket; inCount: number; total: number }> = [];
    const byBooking = new Map<string, { key: string; open: string; ticket: OfflineTicket; inCount: number; total: number }>();
    for (const ticket of searchResults) {
      if (ticket.isMeal) { rows.push({ key: ticket.ticket_uid, open: ticket.ticket_uid, ticket, inCount: ticket.status === 'USED' ? 1 : 0, total: 1 }); continue; }
      const row = byBooking.get(ticket.booking_ref) || { key: ticket.booking_ref, open: ticket.ticket_uid, ticket, inCount: 0, total: 0 };
      row.total += ticket.status === 'CANCELLED' ? 0 : 1;
      row.inCount += ticket.status === 'USED' ? 1 : 0;
      if (!byBooking.has(ticket.booking_ref)) { byBooking.set(ticket.booking_ref, row); rows.push(row); }
    }
    return rows.slice(0, 15);
  })();

  const openFromSearch = (code: string) => {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchFocused(false);
    enqueue(code);
  };

  // ── Start-up ─────────────────────────────────────────────────────────────

  useEffect(() => {
    initDB().then(refreshSyncStatus).catch(err => console.error('IndexedDB init failed:', err));

    // Cache the staff session for offline use, then download today's bookings.
    supabaseBrowser.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      authToken.current = data.session.access_token;
      try {
        const response = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store' });
        const roleData = await response.json();
        if (response.ok && roleData.role) await cacheSession(data.session, roleData.role, data.session.user?.email || '');
      } catch { /* offline — session already cached from previous login */ }
      if (navigator.onLine) syncNow(true);
    });

    const onOnline = () => { setIsOnline(true); setTimeout(() => attemptSync(), 1000); };
    const onOffline = () => setIsOnline(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initializing connection state on mount based on browser API; not derived state.
    setIsOnline(navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Every 30 seconds: send offline check-ins. Every 5 minutes: download today's bookings again, so paid status stays current.
    const interval = setInterval(async () => {
      if (navigator.onLine) {
        attemptSync();
        const lastSync = (await getMeta('last_sync').catch(() => null)) as string | null;
        if (!lastSync || Date.now() - new Date(lastSync).getTime() > DOWNLOAD_EVERY_MS) syncNow(true);
      }
      refreshSyncStatus();
    }, 30000);

    const swMessageHandler = (event: MessageEvent) => { if (event.data?.type === 'SYNC_CHECKINS') attemptSync(); };
    navigator.serviceWorker?.addEventListener('message', swMessageHandler);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearInterval(interval);
      navigator.serviceWorker?.removeEventListener('message', swMessageHandler);
      clearViewTimer();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────────────

  const today = johannesburgToday();
  const card = view.kind === 'card' ? view : null;
  const blocker = card ? checkInBlocker(card.card, today) : null;
  const remaining = card ? Math.max(0, card.card.people - card.card.checkedIn) : 0;

  return (
    <main style={{ minHeight: '100vh', background: '#0f172a', color: 'white', padding: '1rem', paddingBottom: '20vh' }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#38bdf8', fontWeight: 700 }}>GATE STAFF</p>
            <h1>Ticket scanner</h1>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong>{checkedInCount} checked in</strong>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12, padding: '4px 10px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 700, background: isOnline ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: isOnline ? '#10b981' : '#ef4444', border: `1px solid ${isOnline ? '#10b981' : '#ef4444'}` }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: isOnline ? '#10b981' : '#ef4444', display: 'inline-block', animation: isOnline ? undefined : 'pulse 1.5s infinite' }} />
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
        </div>

        {/* Sync status */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginTop: 8, padding: '6px 12px', borderRadius: 8, background: '#1e293b', fontSize: '0.8rem', color: '#94a3b8' }}>
          <span>Last synced: {formatTime(syncStatus.lastSync)} · {syncStatus.ticketCount} tickets loaded</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {syncStatus.pendingCount > 0 && (
              <span style={{ padding: '2px 8px', borderRadius: 12, background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', fontWeight: 700, fontSize: '0.75rem' }}>
                {syncStatus.pendingCount} pending sync{syncStatus.pendingCount !== 1 ? 's' : ''}
              </span>
            )}
            <button onClick={() => syncNow()} disabled={!isOnline || syncing} style={{ padding: '3px 10px', borderRadius: 6, background: isOnline ? '#38bdf8' : '#475569', color: isOnline ? '#082f49' : '#94a3b8', fontWeight: 700, fontSize: '0.75rem', cursor: isOnline && !syncing ? 'pointer' : 'not-allowed', border: 'none', opacity: syncing ? 0.6 : 1 }}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>

        {/* Mode */}
        <div role="radiogroup" aria-label="Scanner" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 12, background: '#1e293b', padding: 4, borderRadius: 10 }}>
          {(['handheld', 'camera'] as const).map(option => (
            <button key={option} role="radio" aria-checked={mode === option} onClick={() => chooseMode(option)} style={{ padding: '0.6rem', borderRadius: 8, border: 'none', fontWeight: 700, cursor: 'pointer', background: mode === option ? '#38bdf8' : 'transparent', color: mode === option ? '#082f49' : '#cbd5e1' }}>
              {option === 'handheld' ? 'Handheld scanner' : 'Use camera instead'}
            </button>
          ))}
        </div>

        {/* Focus guard */}
        {mode === 'handheld' && (focusLost || searchFocused) && (
          <button onClick={() => { setSearchFocused(false); (document.activeElement as HTMLElement | null)?.blur?.(); window.focus(); setFocusLost(false); }} style={{ width: '100%', marginTop: 10, padding: '0.8rem', borderRadius: 10, border: '2px dashed #f59e0b', background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', fontWeight: 800, cursor: 'pointer' }}>
            {searchFocused ? 'Scanning is paused while you type in the search. Tap here to resume scanning.' : 'Tap here to resume scanning'}
          </button>
        )}

        {queued > 0 && (
          <p style={{ marginTop: 10, padding: '6px 12px', borderRadius: 8, background: 'rgba(56, 189, 248, 0.15)', color: '#7dd3fc', fontWeight: 700, fontSize: '0.85rem' }}>
            {queued} more scan{queued === 1 ? '' : 's'} waiting: they open one at a time after this booking.
          </p>
        )}

        {/* Search */}
        <div style={{ background: '#1e293b', padding: '1rem', borderRadius: 12, marginTop: '0.75rem' }}>
          <button onClick={() => { setShowSearch(!showSearch); setSearchQuery(''); setSearchResults([]); setSearchFocused(false); }} style={{ width: '100%', textAlign: 'left', background: 'none', color: '#94a3b8', fontWeight: 600, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: 'none', padding: 0 }}>
            Search name, phone, email, booking or ticket ID
            <span style={{ fontSize: '1.2rem' }}>{showSearch ? '▲' : '▼'}</span>
          </button>
          {showSearch && (
            <div style={{ marginTop: 12 }}>
              <input value={searchQuery} onChange={e => handleSearch(e.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} placeholder="Name, phone, email, BK-... or TKT-..." style={{ width: '100%', padding: '0.75rem', borderRadius: 8, border: 'none', background: '#0f172a', color: 'white', marginBottom: 8 }} autoFocus />
              {searchRows.length > 0 && (
                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {searchRows.map(row => {
                    const done = row.total > 0 && row.inCount >= row.total;
                    return (
                      <button key={row.key} onClick={() => openFromSearch(row.open)} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4, borderRadius: 8, background: done ? '#1c1917' : '#0f172a', color: done ? '#94a3b8' : 'white', border: `1px solid ${done ? '#374151' : '#1e40af'}`, cursor: 'pointer', display: 'block' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <strong>{row.ticket.customer_name}</strong>
                          <span style={{ fontSize: '0.7rem', background: done ? '#7f1d1d' : '#064e3b', padding: '2px 6px', borderRadius: 4 }}>
                            {row.ticket.isMeal ? (done ? 'REDEEMED' : 'MEAL') : `${row.inCount} of ${row.total} in`}
                          </span>
                        </div>
                        {row.ticket.imported && <div style={{ fontSize: '0.7rem', color: '#fde68a', marginTop: 2, fontWeight: 700 }}>IMPORTED BOOKING · no QR code · check in by name</div>}
                        <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                          {row.ticket.isMeal ? `${row.ticket.ticket_uid} · ${row.ticket.package_name}` : row.ticket.booking_ref}
                          {row.ticket.seating && ` · ${row.ticket.seating}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {/^BK-/i.test(searchQuery.trim()) && isOnline && (
                <button onClick={() => openFromSearch(searchQuery.trim().toUpperCase())} style={{ width: '100%', padding: '0.6rem', borderRadius: 8, border: '1px solid #38bdf8', background: 'transparent', color: '#7dd3fc', fontWeight: 700, cursor: 'pointer' }}>
                  Open booking {searchQuery.trim().toUpperCase()}
                </button>
              )}
              {searchQuery.trim().length >= 2 && searchRows.length === 0 && !/^BK-/i.test(searchQuery.trim()) && (
                <p style={{ color: '#94a3b8', textAlign: 'center', padding: 8 }}>No matching bookings found on this device</p>
              )}
            </div>
          )}
        </div>

        {/* Camera (only in camera mode, so it is fully off otherwise) */}
        {mode === 'camera' && <CameraScanner paused={view.kind !== 'idle'} onCode={enqueue} onStatus={setMessage} />}

        {/* Ready panel for the handheld scanner */}
        {mode === 'handheld' && view.kind === 'idle' && (
          <div style={{ marginTop: '1rem', borderRadius: 16, border: '2px solid #1e40af', background: '#0b1a33', padding: '2.5rem 1rem', textAlign: 'center' }}>
            <p style={{ fontSize: '3rem', lineHeight: 1 }} aria-hidden="true">⌁</p>
            <h2 style={{ fontSize: '1.8rem', marginTop: 8 }}>Ready to scan</h2>
            <p style={{ color: '#94a3b8', marginTop: 6 }}>Scan the booking QR code with the handheld scanner.</p>
          </div>
        )}

        {view.kind !== 'card' && <p style={{ textAlign: 'center', color: '#cbd5e1', padding: '1rem' }}>{message}</p>}

        {/* Notice (meal vouchers, errors) */}
        {view.kind === 'notice' && (
          <div onClick={showIdle} style={{ background: view.tone === 'success' ? 'var(--success)' : view.tone === 'warning' ? 'var(--warning)' : 'var(--danger)', borderRadius: 16, padding: '1.5rem', textAlign: 'center', marginBottom: '1rem', animation: 'fadeIn 0.2s ease-out', cursor: 'pointer' }}>
            <h2 style={{ fontSize: '1.8rem' }}>{view.title}</h2>
            {view.detail && <p style={{ marginTop: 8 }}>{view.detail}</p>}
          </div>
        )}

        {/* Booking card */}
        {card && (
          <section aria-label="Booking" style={{ marginTop: '1rem', borderRadius: 16, overflow: 'hidden', border: `3px solid ${blocker ? (remaining === 0 && card.card.active && card.card.visitDate === today ? '#f59e0b' : '#ef4444') : '#10b981'}`, background: '#111c33', animation: 'fadeIn 0.2s ease-out' }}>
            <div style={{ padding: '0.7rem 1rem', fontWeight: 900, letterSpacing: 1, background: blocker ? (remaining === 0 && card.card.active && card.card.visitDate === today ? '#b45309' : '#b91c1c') : '#047857' }}>
              {blocker ? (remaining === 0 && card.card.active && card.card.visitDate === today ? 'ALL CHECKED IN' : card.card.visitDate !== today && card.card.active ? 'WRONG DATE' : 'CANNOT CHECK IN') : 'READY TO CHECK IN'}
              {card.offline && <span style={{ float: 'right', fontSize: '0.7rem', fontWeight: 700, opacity: 0.85 }}>OFFLINE COPY · last sync {formatTime(syncStatus.lastSync)}</span>}
            </div>
            <div style={{ padding: '1rem 1.1rem' }}>
              <h2 style={{ fontSize: '1.9rem', lineHeight: 1.15 }}>{card.card.customerName}</h2>
              <p style={{ color: '#94a3b8', marginTop: 4 }}>
                {card.card.reference} · {shortDate(card.card.visitDate)} · {card.card.partySlot ? <strong style={{ color: '#f9a8d4' }}>Birthday party {card.card.partySlot}</strong> : 'Day visit'}
              </p>
              {card.card.unpaid && (
                <p style={{ marginTop: 6, color: '#fca5a5', fontSize: '0.85rem', fontWeight: 700 }}>
                  ● NOT PAID{card.card.owing > 0 ? ` — owes ${rands(card.card.owing)}` : ''}{card.card.paid > 0 ? ` (${rands(card.card.paid)} paid)` : ''}
                </p>
              )}

              <div style={{ marginTop: 12, padding: '0.75rem', borderRadius: 10, background: '#0b1a33' }}>
                <p style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 700 }}>HUT / TABLE</p>
                <p style={{ fontSize: '1.4rem', fontWeight: 900 }}>{card.card.seating.length ? card.card.seating.join(', ') : 'No hut or table'}</p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 12 }}>
                <div>
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 700 }}>PASSES</p>
                  {card.card.passes.length ? card.card.passes.map(pass => <p key={pass.name} style={{ fontSize: '1rem' }}><strong>{pass.quantity} ×</strong> {pass.name}</p>) : <p>—</p>}
                </div>
                <div>
                  {card.card.names.length > 0 && <>
                    <p style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 700 }}>NAMES</p>
                    <p style={{ fontSize: '0.95rem' }}>{card.card.names.join(', ')}</p>
                  </>}
                  <p style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 700, marginTop: card.card.names.length ? 10 : 0 }}>TOTAL</p>
                  <p style={{ fontSize: '1.1rem', fontWeight: 800 }}>
                    {rands(card.card.total)} · <span style={{ color: card.card.unpaid || card.card.owing > 0 ? '#fca5a5' : '#6ee7b7' }}>{card.card.unpaid ? 'NOT PAID' : card.card.owing > 0 ? `owes ${rands(card.card.owing)}` : 'Paid'}</span>
                  </p>
                </div>
              </div>

              {card.card.notes && <p style={{ marginTop: 12, padding: '0.6rem 0.75rem', borderRadius: 8, background: 'rgba(250, 204, 21, 0.12)', color: '#fde68a' }}><strong>Notes:</strong> {card.card.notes}</p>}
              {card.card.meals > 0 && <p style={{ marginTop: 8, color: '#94a3b8', fontSize: '0.85rem' }}>{card.card.meals} meal voucher{card.card.meals === 1 ? '' : 's'}: scanned separately at the kitchen.</p>}

              <p style={{ marginTop: 14, fontSize: '1.1rem', fontWeight: 800 }}>
                {card.card.checkedIn} of {card.card.people} checked in{card.lastCheckInAt && card.card.checkedIn > 0 ? ` · last at ${formatTime(card.lastCheckInAt)}` : ''}
              </p>

              {card.outcome && (
                <p role="status" style={{ marginTop: 10, padding: '0.75rem', borderRadius: 10, fontWeight: 800, background: card.outcome.ok ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', color: card.outcome.ok ? '#6ee7b7' : '#fca5a5' }}>{card.outcome.text}</p>
              )}
              {blocker && !card.outcome && <p style={{ marginTop: 10, color: remaining === 0 && card.card.active ? '#fcd34d' : '#fca5a5', fontWeight: 700 }}>{blocker}</p>}

              {!blocker && !card.outcome?.ok && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button aria-label="One fewer" onClick={() => setCount(Math.max(1, card.count - 1))} disabled={card.count <= 1} style={{ width: 52, height: 52, borderRadius: 12, border: 'none', fontSize: '1.6rem', fontWeight: 900, background: '#334155', color: 'white', cursor: 'pointer' }}>−</button>
                    <span style={{ minWidth: 44, textAlign: 'center', fontSize: '1.6rem', fontWeight: 900 }} aria-live="polite">{card.count}</span>
                    <button aria-label="One more" onClick={() => setCount(Math.min(remaining, card.count + 1))} disabled={card.count >= remaining} style={{ width: 52, height: 52, borderRadius: 12, border: 'none', fontSize: '1.6rem', fontWeight: 900, background: '#334155', color: 'white', cursor: 'pointer' }}>+</button>
                  </div>
                  <button onClick={() => checkIn(card.count)} style={{ flex: '1 1 200px', minHeight: 56, borderRadius: 12, border: 'none', fontSize: '1.25rem', fontWeight: 900, background: '#10b981', color: '#022c22', cursor: 'pointer' }}>
                    Check in {card.count} {card.count === 1 ? 'person' : 'people'}{card.count < remaining ? ` of ${remaining}` : ''}
                  </button>
                </div>
              )}

              <button onClick={showIdle} style={{ width: '100%', marginTop: 12, padding: '0.8rem', borderRadius: 10, border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', fontWeight: 700, cursor: 'pointer' }}>
                {card.outcome?.ok ? 'Next scan' : 'Close'}
              </button>
            </div>
          </section>
        )}
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </main>
  );
}
