'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useLiveBarcodeScanner, type DetectedBarcode } from '@/lib/qr-scanner';
import {
  initDB,
  lookupTicket,
  searchTickets,
  checkInLocally,
  syncTicketsFromServer,
  pushSyncQueue,
  getSyncStatus,
  getDeviceId,
  cacheSession,
  getCachedSession,
  type OfflineTicket,
  type SyncStatus,
} from '@/lib/offline-db';
import {
  playSuccess,
  playDuplicate,
  playError,
  warmUpAudio,
} from '@/lib/scanner-audio';

// ── Types ──────────────────────────────────────────────────────────────────

type ScanResult = {
  success: boolean;
  status: string;
  ticketUid?: string;
  customerName?: string;
  packageName?: string;
  seating?: string;
  error?: string;
  offline?: boolean;
};

// ── Helpers ────────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

const OVERLAY_COLOR = '#10b981';
const FLASH_HOLD_MS = 300;
const FLASH_FADE_MS = 200;

function traceRoundedPolygon(ctx: CanvasRenderingContext2D, points: Point[], radius: number) {
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.moveTo((last.x + points[0].x) / 2, (last.y + points[0].y) / 2);
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    ctx.arcTo(point.x, point.y, next.x, next.y, radius);
  });
  ctx.closePath();
}

function formatTime(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Scanner() {
  // Camera / scanner
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCodes = useRef<DetectedBarcode[]>([]);
  const flash = useRef<{ points: Point[]; startedAt: number } | null>(null);
  const flashFrame = useRef<number | null>(null);
  const busy = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { start: startLiveScanner, pause: pauseLiveScanner, detectorKind } = useLiveBarcodeScanner(videoRef);

  // Torch
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const videoTrack = useRef<MediaStreamTrack | null>(null);

  // Results & state
  const [result, setResult] = useState<ScanResult | null>(null);
  const [count, setCount] = useState(0);
  const [message, setMessage] = useState('Starting camera...');

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<OfflineTicket[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  // Online / offline & sync
  const [isOnline, setIsOnline] = useState(true);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ lastSync: null, ticketCount: 0, pendingCount: 0 });
  const [syncing, setSyncing] = useState(false);
  const syncInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const authToken = useRef<string | null>(null);

  // ── Auth token ───────────────────────────────────────────────────────────

  const getAuthToken = useCallback(async (): Promise<string | null> => {
    if (authToken.current) return authToken.current;
    try {
      const session = (await supabaseBrowser.auth.getSession()).data.session;
      if (session) {
        authToken.current = session.access_token;
        return session.access_token;
      }
    } catch { /* offline */ }
    // Fallback to cached session
    const cached = await getCachedSession();
    if (cached) {
      authToken.current = cached.access_token;
      return cached.access_token;
    }
    return null;
  }, []);

  // ── Sync status refresh ──────────────────────────────────────────────────

  const refreshSyncStatus = useCallback(async () => {
    try {
      const status = await getSyncStatus();
      setSyncStatus(status);
    } catch { /* IDB not ready yet */ }
  }, []);

  // ── Push sync queue ──────────────────────────────────────────────────────

  const attemptSync = useCallback(async () => {
    if (syncing || !navigator.onLine) return;
    const token = await getAuthToken();
    if (!token) return;

    try {
      setSyncing(true);
      const status = await getSyncStatus();
      if (status.pendingCount === 0) return;

      await pushSyncQueue(token);
      await refreshSyncStatus();
    } catch (err) {
      console.warn('Sync attempt failed:', err);
    } finally {
      setSyncing(false);
    }
  }, [syncing, getAuthToken, refreshSyncStatus]);

  // ── Sync tickets from server ─────────────────────────────────────────────

  const syncNow = useCallback(async () => {
    const token = await getAuthToken();
    if (!token) {
      setMessage('No auth token — please sign in');
      return;
    }
    try {
      setSyncing(true);
      setMessage('Syncing tickets…');

      // Push any pending check-ins first
      await pushSyncQueue(token).catch(() => {});

      // Then download fresh ticket data
      const result = await syncTicketsFromServer(token);
      await refreshSyncStatus();
      setMessage(`Synced ${result.count} tickets at ${formatTime(result.synced_at)}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [getAuthToken, refreshSyncStatus]);

  // ── Live detection overlay ───────────────────────────────────────────────

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !video || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { videoWidth, videoHeight } = video;
    if (!videoWidth || !videoHeight) return;
    // Map video pixels to the on-screen box, matching the video's object-fit: cover crop.
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const offsetX = (width - videoWidth * scale) / 2;
    const offsetY = (height - videoHeight * scale) / 2;
    const toScreen = (point: Point) => ({ x: offsetX + point.x * scale, y: offsetY + point.y * scale });

    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = OVERLAY_COLOR;
    ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
    for (const code of overlayCodes.current) {
      traceRoundedPolygon(ctx, code.cornerPoints.map(toScreen), 10);
      ctx.fill();
      ctx.stroke();
    }

    if (flash.current) {
      const elapsed = performance.now() - flash.current.startedAt;
      const alpha = elapsed <= FLASH_HOLD_MS ? 0.85 : Math.max(0, 0.85 * (1 - (elapsed - FLASH_HOLD_MS) / FLASH_FADE_MS));
      traceRoundedPolygon(ctx, flash.current.points.map(toScreen), 10);
      ctx.fillStyle = `rgba(16, 185, 129, ${alpha})`;
      ctx.fill();
      ctx.globalAlpha = Math.min(1, alpha / 0.85);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }, []);

  const startFlash = useCallback((points: Point[]) => {
    flash.current = { points, startedAt: performance.now() };
    if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
    // Runs on its own frames so the flash still fades after the camera pauses.
    const step = () => {
      drawOverlay();
      if (flash.current && performance.now() - flash.current.startedAt < FLASH_HOLD_MS + FLASH_FADE_MS) {
        flashFrame.current = requestAnimationFrame(step);
      } else {
        flash.current = null;
        flashFrame.current = null;
        drawOverlay();
      }
    };
    flashFrame.current = requestAnimationFrame(step);
  }, [drawOverlay]);

  const pauseCamera = useCallback(() => {
    pauseLiveScanner();
    overlayCodes.current = [];
    if (!flash.current) drawOverlay();
  }, [pauseLiveScanner, drawOverlay]);

  // ── Process a scanned / entered code ─────────────────────────────────────

  const processCode = useCallback(async (value: string) => {
    if (busy.current || !value.trim()) return;
    busy.current = true;
    setMessage('Checking ticket…');
    warmUpAudio();

    try {
      const code = value.trim();

      // 1. Try offline lookup first (always, even when online)
      const ticket = await lookupTicket(code);

      if (ticket) {
        const today = new Date().toISOString().slice(0, 10);

        if (ticket.status === 'USED') {
          playDuplicate();
          setResult({
            success: false,
            status: 'USED',
            ticketUid: ticket.ticket_uid,
            customerName: ticket.customer_name,
            packageName: ticket.package_name,
            seating: ticket.seating,
            error: 'This ticket has already been scanned',
          });
          setMessage('Already scanned');
          pauseCamera();
          return;
        }

        if (ticket.visit_date !== today) {
          playError();
          setResult({
            success: false,
            status: 'EXPIRED',
            ticketUid: ticket.ticket_uid,
            customerName: ticket.customer_name,
            packageName: ticket.package_name,
            seating: ticket.seating,
            error: `Ticket is for ${ticket.visit_date}, not today`,
          });
          setMessage('Wrong date');
          pauseCamera();
          return;
        }

        if (ticket.status === 'CANCELLED') {
          playError();
          setResult({
            success: false,
            status: 'CANCELLED',
            ticketUid: ticket.ticket_uid,
            customerName: ticket.customer_name,
            packageName: ticket.package_name,
            error: 'Ticket is cancelled',
          });
          setMessage('Cancelled ticket');
          pauseCamera();
          return;
        }

        // Valid ticket — check in locally
        const deviceId = getDeviceId();
        const checkinResult = await checkInLocally(ticket.ticket_uid, deviceId);

        if (checkinResult.success) {
          playSuccess();
          setResult({
            success: true,
            status: 'APPROVED',
            ticketUid: ticket.ticket_uid,
            customerName: ticket.customer_name,
            packageName: ticket.package_name,
            seating: ticket.seating,
            offline: !navigator.onLine,
          });
          setCount(c => c + 1);
          setMessage('Access approved');
          await refreshSyncStatus();

          // Try to register for Background Sync
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            try {
              const reg = await navigator.serviceWorker.ready;
              await (reg as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } }).sync.register('sync-checkins');
            } catch { /* Background Sync not available */ }
          }

          // If online, push sync immediately
          if (navigator.onLine) {
            setTimeout(() => attemptSync(), 500);
          }
        } else {
          playError();
          setResult({
            success: false,
            status: checkinResult.error === 'ALREADY_SCANNED' ? 'USED' : 'INVALID',
            ticketUid: ticket.ticket_uid,
            customerName: ticket.customer_name,
            packageName: ticket.package_name,
            error: checkinResult.error,
          });
          setMessage(checkinResult.error || 'Check-in failed');
        }

        pauseCamera();
        return;
      }

      // 2. Ticket not found locally — try server if online
      if (navigator.onLine) {
        const token = await getAuthToken();
        if (!token) throw new Error('Your staff session has expired');

        const lookup = code.toUpperCase().startsWith('BK-')
          ? { reference: code }
          : code.toUpperCase().startsWith('TKT-')
            ? { ticketUid: code }
            : { token: code };

        const response = await fetch('/api/admin/scan', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(lookup),
        });
        const data = await response.json();

        if (data.success) {
          playSuccess();
          setCount(c => c + 1);
        } else if (data.status === 'USED') {
          playDuplicate();
        } else {
          playError();
        }

        setResult(data);
        setMessage(data.success ? 'Access approved' : data.error || 'Ticket rejected');
      } else {
        // Offline and ticket not in local DB
        playError();
        setResult({
          success: false,
          status: 'NOT_FOUND',
          error: 'Ticket not found in offline database. Try syncing when online.',
        });
        setMessage('Not found offline');
      }

      pauseCamera();
    } catch (error) {
      playError();
      setMessage(error instanceof Error ? error.message : 'Could not process scan');
    } finally {
      busy.current = false;
    }
  }, [getAuthToken, refreshSyncStatus, attemptSync, pauseCamera]);

  // ── Live frames ──────────────────────────────────────────────────────────

  // Runs every camera frame: only the overlay redraw happens per frame; a code
  // reaches processCode at most once per debounce window.
  const handleFrame = useCallback((codes: DetectedBarcode[]) => {
    if (codes.length > 0 || overlayCodes.current.length > 0) {
      overlayCodes.current = codes;
      drawOverlay();
    }

    const code = codes.find(candidate => candidate.rawValue);
    if (!code) return;

    // Debounce: ignore scans for 2 seconds after a successful read
    if (debounceTimer.current) return;
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
    }, 2000);
    // processCode drops reads while it's busy (e.g. a slow online lookup), so
    // don't give "got it" feedback for those.
    if (!busy.current) {
      if (typeof navigator.vibrate === 'function') navigator.vibrate(100);
      startFlash(code.cornerPoints);
    }
    processCode(code.rawValue);
  }, [drawOverlay, startFlash, processCode]);

  // ── Start scanner ────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    const track = await startLiveScanner(handleFrame);
    if (!track) return; // superseded by a newer start/pause/unmount
    setMessage('Point the camera at a ticket QR code');

    // Check torch support
    try {
      videoTrack.current = track;
      const capabilities = track.getCapabilities?.();
      if (capabilities && 'torch' in capabilities) {
        setTorchSupported(true);
      }
    } catch { /* torch detection failed */ }
  }, [startLiveScanner, handleFrame]);

  // ── Torch toggle ─────────────────────────────────────────────────────────

  const toggleTorch = useCallback(async () => {
    if (!videoTrack.current) return;
    try {
      const newState = !torchOn;
      await videoTrack.current.applyConstraints({
        advanced: [{ torch: newState } as MediaTrackConstraintSet],
      });
      setTorchOn(newState);
    } catch {
      setMessage('Flashlight not available on this device');
    }
  }, [torchOn]);

  // ── Search handler ───────────────────────────────────────────────────────

  const handleSearch = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await searchTickets(query, 10);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    }
  }, []);

  const checkInFromSearch = useCallback(async (ticket: OfflineTicket) => {
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    await processCode(ticket.ticket_uid);
  }, [processCode]);

  // ── Initialize ───────────────────────────────────────────────────────────

  useEffect(() => {
    // Initialize IndexedDB
    initDB().then(async () => {
      await refreshSyncStatus();
    }).catch(err => {
      console.error('IndexedDB init failed:', err);
    });

    // Cache auth session for offline use
    supabaseBrowser.auth.getSession().then(async ({ data }) => {
      if (data.session) {
        authToken.current = data.session.access_token;
        try {
          const response = await fetch('/api/admin/me', {
            headers: { Authorization: `Bearer ${data.session.access_token}` },
            cache: 'no-store',
          });
          const roleData = await response.json();
          if (response.ok && roleData.role) {
            await cacheSession(data.session, roleData.role, data.session.user?.email || '');
          }
        } catch { /* offline — session already cached from previous login */ }
      }
    });

    // Online/offline listeners
    const onOnline = () => {
      setIsOnline(true);
      // Auto-sync when connectivity returns
      setTimeout(() => attemptSync(), 1000);
    };
    const onOffline = () => setIsOnline(false);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initializing connection state on mount based on browser API; not derived state.
    setIsOnline(navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Periodic sync retry (every 30s) — fallback for unreliable online event
    syncInterval.current = setInterval(() => {
      if (navigator.onLine) {
        attemptSync();
      }
      refreshSyncStatus();
    }, 30000);

    // Listen for service worker sync messages
    const swMessageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'SYNC_CHECKINS') {
        attemptSync();
      }
    };
    navigator.serviceWorker?.addEventListener('message', swMessageHandler);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (syncInterval.current) clearInterval(syncInterval.current);
      navigator.serviceWorker?.removeEventListener('message', swMessageHandler);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Camera lifecycle ─────────────────────────────────────────────────────

  // The stream itself is released by useLiveBarcodeScanner's own unmount cleanup,
  // which also bumps its generation so a start still in flight can't reopen it.
  useEffect(() => {
    let cancelled = false;

    const startupTimer = window.setTimeout(() => {
      if (cancelled) return;
      startCamera().catch(() => {
        if (!cancelled) {
          setMessage('Camera unavailable. Use manual entry below.');
        }
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
      if (flashFrame.current !== null) cancelAnimationFrame(flashFrame.current);
      flashFrame.current = null;
      flash.current = null;
      overlayCodes.current = [];
      videoTrack.current = null;
      setTorchSupported(false);
      setTorchOn(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scan next ────────────────────────────────────────────────────────────

  const scanNext = async () => {
    setResult(null);
    setMessage('Starting camera…');
    busy.current = false;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    await startCamera().catch(() => setMessage('Use manual entry below.'));
  };

  // ── Render helpers ───────────────────────────────────────────────────────

  const statusColor = result?.success
    ? 'var(--success)'
    : result
      ? result.status === 'USED' ? 'var(--danger)' : 'var(--warning)'
      : 'var(--primary)';

  const resultTitle = result?.success
    ? 'ACCESS APPROVED'
    : result?.status === 'USED'
      ? 'TICKET HAS BEEN SCANNED'
      : result?.status === 'EXPIRED'
        ? 'WRONG DATE'
        : result?.status === 'CANCELLED'
          ? 'CANCELLED'
          : result?.status === 'NOT_FOUND'
            ? 'NOT FOUND'
            : 'INVALID TICKET';

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main style={{ minHeight: '100vh', background: '#0f172a', color: 'white', padding: '1rem', paddingBottom: '20vh' }}>
      <div style={{ maxWidth: 620, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <p style={{ color: '#38bdf8', fontWeight: 700 }}>GATE STAFF</p>
            <h1>Ticket scanner</h1>
          </div>
          <div style={{ textAlign: 'right' }}>
            <strong>{count} scanned</strong>
            {/* Online/Offline indicator */}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 12,
              padding: '4px 10px',
              borderRadius: 20,
              fontSize: '0.75rem',
              fontWeight: 700,
              background: isOnline ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
              color: isOnline ? '#10b981' : '#ef4444',
              border: `1px solid ${isOnline ? '#10b981' : '#ef4444'}`,
            }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: isOnline ? '#10b981' : '#ef4444',
                display: 'inline-block',
                animation: isOnline ? undefined : 'pulse 1.5s infinite',
              }} />
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </div>
          </div>
        </div>

        {/* Sync status bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          marginTop: 8,
          padding: '6px 12px',
          borderRadius: 8,
          background: '#1e293b',
          fontSize: '0.8rem',
          color: '#94a3b8',
        }}>
          <span>
            Last synced: {formatTime(syncStatus.lastSync)} · {syncStatus.ticketCount} tickets loaded
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {syncStatus.pendingCount > 0 && (
              <span style={{
                padding: '2px 8px',
                borderRadius: 12,
                background: 'rgba(245, 158, 11, 0.2)',
                color: '#f59e0b',
                fontWeight: 700,
                fontSize: '0.75rem',
              }}>
                {syncStatus.pendingCount} pending sync{syncStatus.pendingCount !== 1 ? 's' : ''}
              </span>
            )}
            <button
              onClick={syncNow}
              disabled={!isOnline || syncing}
              style={{
                padding: '3px 10px',
                borderRadius: 6,
                background: isOnline ? '#38bdf8' : '#475569',
                color: isOnline ? '#082f49' : '#94a3b8',
                fontWeight: 700,
                fontSize: '0.75rem',
                cursor: isOnline && !syncing ? 'pointer' : 'not-allowed',
                border: 'none',
                opacity: syncing ? 0.6 : 1,
              }}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>

        {/* Search by name fallback (Moved up for mobile visibility) */}
        <div style={{ background: '#1e293b', padding: '1rem', borderRadius: 12, marginTop: '1rem', marginBottom: '0.75rem' }}>
          <button
            onClick={() => { setShowSearch(!showSearch); setSearchQuery(''); setSearchResults([]); }}
            style={{
              width: '100%',
              textAlign: 'left',
              background: 'none',
              color: '#94a3b8',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              border: 'none',
              padding: 0,
            }}
          >
            Search name, booking, or ticket ID
            <span style={{ fontSize: '1.2rem' }}>{showSearch ? '▲' : '▼'}</span>
          </button>

          {showSearch && (
            <div style={{ marginTop: 12 }}>
              <input
                value={searchQuery}
                onChange={e => handleSearch(e.target.value)}
                placeholder="Type a name, BK-..., or TKT-..."
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: 8,
                  border: 'none',
                  background: '#0f172a',
                  color: 'white',
                  marginBottom: 8,
                }}
                autoFocus
              />
              {searchResults.length > 0 && (
                <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {searchResults.map(ticket => (
                    <button
                      key={ticket.ticket_uid}
                      onClick={() => checkInFromSearch(ticket)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        marginBottom: 4,
                        borderRadius: 8,
                        background: ticket.status === 'USED' ? '#1c1917' : '#0f172a',
                        color: ticket.status === 'USED' ? '#94a3b8' : 'white',
                        border: `1px solid ${ticket.status === 'USED' ? '#374151' : '#1e40af'}`,
                        cursor: 'pointer',
                        display: 'block',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong>{ticket.customer_name}</strong>
                        {ticket.status === 'USED' && (
                          <span style={{ fontSize: '0.7rem', background: '#7f1d1d', padding: '2px 6px', borderRadius: 4 }}>
                            SCANNED
                          </span>
                        )}
                        {ticket.status === 'VALID' && (
                          <span style={{ fontSize: '0.7rem', background: '#064e3b', padding: '2px 6px', borderRadius: 4 }}>
                            VALID
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 2 }}>
                        {ticket.ticket_uid} · {ticket.package_name}
                        {ticket.seating && ` · ${ticket.seating}`}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {searchQuery.trim().length >= 2 && searchResults.length === 0 && (
                <p style={{ color: '#94a3b8', textAlign: 'center', padding: 8 }}>
                  No matching tickets found
                </p>
              )}
            </div>
          )}
        </div>

        {/* Camera viewfinder */}
        <div style={{ position: 'relative', marginTop: '1rem' }}>
          <div
            style={{
              position: 'relative',
              overflow: 'hidden',
              borderRadius: 16,
              background: '#020617',
              aspectRatio: '1 / 1',
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            />
            {detectorKind === 'polyfill' && (
              <span style={{
                position: 'absolute',
                left: 10,
                bottom: 8,
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: '0.7rem',
                color: 'rgba(255,255,255,0.75)',
                background: 'rgba(2, 6, 23, 0.55)',
                pointerEvents: 'none',
              }}>
                Backup scanner
              </span>
            )}
          </div>

          {/* Torch toggle */}
          {torchSupported && (
            <button
              onClick={toggleTorch}
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 10,
                width: 44,
                height: 44,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: torchOn ? '#f59e0b' : 'rgba(255,255,255,0.15)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '1.4rem',
                backdropFilter: 'blur(4px)',
                transition: 'background 0.2s',
              }}
              aria-label={torchOn ? 'Turn off flashlight' : 'Turn on flashlight'}
              title={torchOn ? 'Flashlight ON' : 'Flashlight OFF'}
            >
              {torchOn ? '🔦' : '💡'}
            </button>
          )}
        </div>

        <p style={{ textAlign: 'center', color: '#cbd5e1', padding: '1rem' }}>{message}</p>

        {/* Scan result */}
        {result && (
          <div style={{
            background: statusColor,
            borderRadius: 16,
            padding: '1.5rem',
            textAlign: 'center',
            marginBottom: '1rem',
            animation: 'fadeIn 0.2s ease-out',
          }}>
            <h2 style={{ fontSize: '2rem' }}>{resultTitle}</h2>
            {result.ticketUid && (
              <p style={{ marginTop: 8 }}>
                {result.ticketUid} · {result.customerName} · {result.packageName}
              </p>
            )}
            {result.seating && (
              <p style={{ marginTop: 8, fontWeight: 800 }}>Seating: {result.seating}</p>
            )}
            {result.error && <p style={{ marginTop: 8 }}>{result.error}</p>}
            {result.offline && (
              <p style={{ marginTop: 8, fontSize: '0.8rem', opacity: 0.8 }}>
                ✓ Checked in offline — will sync when connected
              </p>
            )}
          </div>
        )}

        {/* Scan next button */}
        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '1rem', marginBottom: '1rem', fontSize: '1.1rem' }}
          onClick={scanNext}
        >
          Scan next ticket
        </button>



      </div>

      {/* Inline styles for animations */}
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
