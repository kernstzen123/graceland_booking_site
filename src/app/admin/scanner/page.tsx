'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { supabaseBrowser } from '@/lib/supabase-browser';
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

async function stopScanner(instance: Html5Qrcode | null) {
  if (!instance || !instance.isScanning) return;
  try { await instance.stop(); } catch { /* camera may already be stopped */ }
}

async function disposeScanner(instance: Html5Qrcode | null) {
  if (!instance) return;
  await stopScanner(instance);
  try { instance.clear(); } catch { /* the renderer may not have mounted yet */ }
}

function formatTime(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Scanner() {
  // Camera / scanner
  const scanner = useRef<Html5Qrcode | null>(null);
  const startPromise = useRef<Promise<void> | null>(null);
  const startInstance = useRef<Html5Qrcode | null>(null);
  const scannerGeneration = useRef(0);
  const busy = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          await stopScanner(scanner.current);
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
          await stopScanner(scanner.current);
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
          await stopScanner(scanner.current);
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

        await stopScanner(scanner.current);
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

      await stopScanner(scanner.current);
    } catch (error) {
      playError();
      setMessage(error instanceof Error ? error.message : 'Could not process scan');
    } finally {
      busy.current = false;
    }
  }, [getAuthToken, refreshSyncStatus, attemptSync]);

  // ── Start scanner ────────────────────────────────────────────────────────

  const startScanner = useCallback(async (instance: Html5Qrcode, generation = scannerGeneration.current) => {
    if (instance.isScanning) return;
    if (startInstance.current === instance && startPromise.current) return startPromise.current;

    const promise = instance.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: { width: 260, height: 260 },
        aspectRatio: 1.0,
        videoConstraints: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // @ts-expect-error -- focusMode is valid but not in all TS definitions
          focusMode: 'continuous',
        },
      },
      (text) => {
        // Debounce: ignore scans for 2 seconds after a successful read
        if (debounceTimer.current) return;
        debounceTimer.current = setTimeout(() => {
          debounceTimer.current = null;
        }, 2000);
        processCode(text);
      },
      () => undefined,
    ).then(async () => {
      if (generation !== scannerGeneration.current) {
        await disposeScanner(instance);
        return;
      }
      setMessage('Point the camera at a ticket QR code');

      // Check torch support
      try {
        const videoElement = document.querySelector('#qr-reader video') as HTMLVideoElement | null;
        if (videoElement?.srcObject) {
          const stream = videoElement.srcObject as MediaStream;
          const track = stream.getVideoTracks()[0];
          if (track) {
            videoTrack.current = track;
            const capabilities = track.getCapabilities?.();
            if (capabilities && 'torch' in capabilities) {
              setTorchSupported(true);
            }
          }
        }
      } catch { /* torch detection failed */ }
    });

    startInstance.current = instance;
    startPromise.current = promise;
    try {
      await promise;
    } finally {
      if (startInstance.current === instance) {
        startInstance.current = null;
        startPromise.current = null;
      }
    }
  }, [processCode]);

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

  useEffect(() => {
    const generation = scannerGeneration.current + 1;
    scannerGeneration.current = generation;
    const instance = new Html5Qrcode('qr-reader');
    scanner.current = instance;
    let cancelled = false;

    const startupTimer = window.setTimeout(() => {
      if (cancelled) return;
      startScanner(instance, generation).catch(() => {
        if (!cancelled && generation === scannerGeneration.current) {
          setMessage('Camera unavailable. Use manual entry below.');
        }
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
      scannerGeneration.current += 1;
      if (scanner.current === instance) scanner.current = null;
      videoTrack.current = null;
      setTorchSupported(false);
      setTorchOn(false);
      void disposeScanner(instance).finally(() => {
        const reader = document.getElementById('qr-reader');
        if (reader && scannerGeneration.current !== generation) reader.replaceChildren();
      });
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
    if (scanner.current) {
      await startScanner(scanner.current).catch(() => setMessage('Use manual entry below.'));
    }
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
            id="qr-reader"
            style={{
              overflow: 'hidden',
              borderRadius: 16,
              background: '#020617',
            }}
          />

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



        {/* Navigation */}
        <a
          href="/admin"
          className="btn"
          style={{ width: '100%', marginTop: '0.5rem', border: '1px solid #475569', color: 'white' }}
        >
          Back to dashboard
        </a>
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
