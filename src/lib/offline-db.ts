'use client';

// ---------------------------------------------------------------------------
// Offline-first IndexedDB layer for the ticket scanner.
//
// Stores:
//   tickets     – mirror of server tickets for today, keyed by ticket_uid
//   sync_queue  – check-in events waiting to be pushed to the server
//   meta        – key/value pairs (last_sync, ticket_count, device_id, cached_session)
// ---------------------------------------------------------------------------

const DB_NAME = 'graceland-scanner';
const DB_VERSION = 2;

// ── Types ──────────────────────────────────────────────────────────────────

export type OfflineTicket = {
  ticket_uid: string;
  ticket_id: string; // server UUID
  booking_id: string;
  booking_ref: string;
  customer_name: string;
  package_name: string;
  seating: string;
  visit_date: string;
  status: 'VALID' | 'USED' | 'CANCELLED';
  qr_token: string;
  checked_in_at: string | null;
  checked_in_by_device: string | null;
};

export type SyncQueueItem = {
  id?: number; // auto-increment
  ticket_uid: string;
  ticket_id: string;
  checked_in_at: string;
  device_id: string;
  synced: number; // 0 for false, 1 for true
  retries: number;
  last_error: string | null;
};

export type CachedSession = {
  access_token: string;
  role: string;
  email: string;
  expires_at: number; // epoch ms
};

// ── Database init ──────────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

export function initDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;

      // Drop old stores if upgrading
      if (event.oldVersion < 2) {
        if (db.objectStoreNames.contains('tickets')) db.deleteObjectStore('tickets');
        if (db.objectStoreNames.contains('sync_queue')) db.deleteObjectStore('sync_queue');
        if (db.objectStoreNames.contains('meta')) db.deleteObjectStore('meta');
      }

      // Tickets store — keyed by ticket_uid
      if (!db.objectStoreNames.contains('tickets')) {
        const tickets = db.createObjectStore('tickets', { keyPath: 'ticket_uid' });
        tickets.createIndex('qr_token', 'qr_token', { unique: true });
        tickets.createIndex('booking_ref', 'booking_ref', { unique: false });
        tickets.createIndex('customer_name', 'customer_name', { unique: false });
        tickets.createIndex('visit_date', 'visit_date', { unique: false });
        tickets.createIndex('status', 'status', { unique: false });
      }

      // Sync queue — auto-increment key
      if (!db.objectStoreNames.contains('sync_queue')) {
        const queue = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
        queue.createIndex('synced', 'synced', { unique: false });
        queue.createIndex('ticket_uid', 'ticket_uid', { unique: false });
      }

      // Meta — simple key/value store
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function tx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode) {
  return db.transaction(stores, mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

// ── Device ID ──────────────────────────────────────────────────────────────

export function getDeviceId(): string {
  const key = 'graceland_device_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

// ── Meta store helpers ─────────────────────────────────────────────────────

export async function getMeta(key: string): Promise<unknown> {
  const db = await initDB();
  const t = tx(db, 'meta', 'readonly');
  const result = await reqToPromise(t.objectStore('meta').get(key));
  return result?.value ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await initDB();
  const t = tx(db, 'meta', 'readwrite');
  t.objectStore('meta').put({ key, value });
  await txDone(t);
}

// ── Session caching ────────────────────────────────────────────────────────

export async function cacheSession(session: { access_token: string; expires_at?: number }, role: string, email: string): Promise<void> {
  const cached: CachedSession = {
    access_token: session.access_token,
    role,
    email,
    // Supabase JWTs default to 1 hour; keep the cached session for 8 hours
    // so staff can work through a full shift without re-logging in.
    expires_at: session.expires_at ? session.expires_at * 1000 : Date.now() + 8 * 60 * 60 * 1000,
  };
  await setMeta('cached_session', cached);
}

export async function getCachedSession(): Promise<CachedSession | null> {
  const cached = (await getMeta('cached_session')) as CachedSession | null;
  if (!cached) return null;
  if (Date.now() > cached.expires_at) return null;
  return cached;
}

export async function clearCachedSession(): Promise<void> {
  await setMeta('cached_session', null);
}

// ── Sync tickets from server ───────────────────────────────────────────────

export async function syncTicketsFromServer(authToken: string, date?: string): Promise<{ count: number; synced_at: string }> {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const response = await fetch(`/api/admin/scan/sync-tickets?date=${targetDate}`, {
    headers: { Authorization: `Bearer ${authToken}` },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Sync failed (${response.status})`);
  }

  const data = await response.json();
  const tickets: OfflineTicket[] = data.tickets;
  const synced_at: string = data.synced_at;

  const db = await initDB();

  // Wipe and repopulate tickets store.
  // We need to preserve local check-in status for tickets we already
  // marked as USED offline but haven't synced yet.
  const t = tx(db, ['tickets', 'sync_queue'], 'readwrite');
  const ticketStore = t.objectStore('tickets');
  const queueStore = t.objectStore('sync_queue');

  // Collect ticket_uids that are in the pending sync queue
  const pendingUids = new Set<string>();
  const queueCursor = queueStore.index('synced').openCursor(IDBKeyRange.only(0));
  await new Promise<void>((resolve, reject) => {
    queueCursor.onsuccess = () => {
      const cursor = queueCursor.result;
      if (cursor) {
        pendingUids.add((cursor.value as SyncQueueItem).ticket_uid);
        cursor.continue();
      } else {
        resolve();
      }
    };
    queueCursor.onerror = () => reject(queueCursor.error);
  });

  // Clear existing tickets
  ticketStore.clear();

  // Populate with fresh server data, preserving local USED status for pending syncs
  for (const ticket of tickets) {
    if (pendingUids.has(ticket.ticket_uid)) {
      // This ticket was checked in locally but not yet synced — keep it as USED
      ticket.status = 'USED';
    }
    ticketStore.put(ticket);
  }

  await txDone(t);

  await setMeta('last_sync', synced_at);
  await setMeta('ticket_count', tickets.length);

  return { count: tickets.length, synced_at };
}

// ── Ticket lookup ──────────────────────────────────────────────────────────

export async function lookupTicket(code: string): Promise<OfflineTicket | null> {
  const db = await initDB();
  const t = tx(db, 'tickets', 'readonly');
  const store = t.objectStore('tickets');
  const normalized = code.trim();

  // 1. Direct ticket_uid match (TKT-XXXX)
  if (normalized.toUpperCase().startsWith('TKT-')) {
    const result = await reqToPromise(store.get(normalized.toUpperCase()));
    if (result) return result as OfflineTicket;
  }

  // 2. Booking reference match (BK-XXXX)
  if (normalized.toUpperCase().startsWith('BK-')) {
    const idx = store.index('booking_ref');
    const result = await reqToPromise(idx.get(normalized.toUpperCase()));
    if (result) return result as OfflineTicket;
  }

  // 3. QR token match (could be the raw token or a URL containing it)
  let tokenValue = normalized;
  try {
    const url = new URL(normalized);
    tokenValue = url.searchParams.get('token') || normalized;
  } catch { /* not a URL, use raw value */ }

  const idx = store.index('qr_token');
  const result = await reqToPromise(idx.get(tokenValue));
  if (result) return result as OfflineTicket;

  // 4. Also try direct key match (if it's some other format)
  const directResult = await reqToPromise(store.get(normalized));
  if (directResult) return directResult as OfflineTicket;

  return null;
}

// ── Search tickets by name / reference ─────────────────────────────────────

export async function searchTickets(query: string, limit = 20): Promise<OfflineTicket[]> {
  if (!query.trim()) return [];
  const db = await initDB();
  const t = tx(db, 'tickets', 'readonly');
  const store = t.objectStore('tickets');
  const results: OfflineTicket[] = [];
  const lowerQuery = query.toLowerCase().trim();

  return new Promise((resolve, reject) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || results.length >= limit) {
        resolve(results);
        return;
      }
      const ticket = c.value as OfflineTicket;
      if (
        ticket.customer_name.toLowerCase().includes(lowerQuery) ||
        ticket.booking_ref.toLowerCase().includes(lowerQuery) ||
        ticket.ticket_uid.toLowerCase().includes(lowerQuery)
      ) {
        results.push(ticket);
      }
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// ── Local check-in ─────────────────────────────────────────────────────────

export async function checkInLocally(ticketUid: string, deviceId: string): Promise<{ success: boolean; ticket?: OfflineTicket; error?: string }> {
  const db = await initDB();
  const t = tx(db, ['tickets', 'sync_queue'], 'readwrite');
  const ticketStore = t.objectStore('tickets');
  const queueStore = t.objectStore('sync_queue');

  const ticket = await reqToPromise(ticketStore.get(ticketUid)) as OfflineTicket | undefined;
  if (!ticket) {
    return { success: false, error: 'Ticket not found in local database' };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (ticket.visit_date !== today) {
    return { success: false, ticket, error: 'WRONG DATE' };
  }

  if (ticket.status === 'USED') {
    return { success: false, ticket, error: 'ALREADY_SCANNED' };
  }

  if (ticket.status === 'CANCELLED') {
    return { success: false, ticket, error: 'CANCELLED' };
  }

  // Mark as checked in
  const now = new Date().toISOString();
  ticket.status = 'USED';
  ticket.checked_in_at = now;
  ticket.checked_in_by_device = deviceId;
  ticketStore.put(ticket);

  // Queue for server sync
  const queueItem: SyncQueueItem = {
    ticket_uid: ticketUid,
    ticket_id: ticket.ticket_id,
    checked_in_at: now,
    device_id: deviceId,
    synced: 0,
    retries: 0,
    last_error: null,
  };
  queueStore.add(queueItem);

  await txDone(t);

  return { success: true, ticket };
}

// ── Sync queue ─────────────────────────────────────────────────────────────

export async function getPendingSyncCount(): Promise<number> {
  const db = await initDB();
  const t = tx(db, 'sync_queue', 'readonly');
  const idx = t.objectStore('sync_queue').index('synced');
  return reqToPromise(idx.count(IDBKeyRange.only(0)));
}

export async function getPendingSyncItems(): Promise<SyncQueueItem[]> {
  const db = await initDB();
  const t = tx(db, 'sync_queue', 'readonly');
  const idx = t.objectStore('sync_queue').index('synced');
  return reqToPromise(idx.getAll(IDBKeyRange.only(0)));
}

export async function pushSyncQueue(authToken: string): Promise<{ pushed: number; errors: number }> {
  const pending = await getPendingSyncItems();
  if (pending.length === 0) return { pushed: 0, errors: 0 };

  const response = await fetch('/api/admin/scan/batch-checkin', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      checkins: pending.map(item => ({
        ticket_uid: item.ticket_uid,
        ticket_id: item.ticket_id,
        checked_in_at: item.checked_in_at,
        device_id: item.device_id,
      })),
    }),
  });

  if (!response.ok) {
    // Mark all as retry
    const db = await initDB();
    const t = tx(db, 'sync_queue', 'readwrite');
    const store = t.objectStore('sync_queue');
    for (const item of pending) {
      item.retries += 1;
      item.last_error = `Server responded ${response.status}`;
      store.put(item);
    }
    await txDone(t);
    return { pushed: 0, errors: pending.length };
  }

  const data = await response.json();
  const results: Array<{ ticket_uid: string; status: string }> = data.results || [];

  const db = await initDB();
  const t = tx(db, 'sync_queue', 'readwrite');
  const store = t.objectStore('sync_queue');
  let pushed = 0;
  let errors = 0;

  for (const item of pending) {
    const serverResult = results.find(r => r.ticket_uid === item.ticket_uid);
    if (serverResult && (serverResult.status === 'ok' || serverResult.status === 'conflict')) {
      // Successfully synced (conflict means server accepted but flagged it)
      item.synced = 1;
      item.last_error = serverResult.status === 'conflict' ? 'Duplicate detected by server' : null;
      pushed++;
    } else {
      item.retries += 1;
      item.last_error = serverResult?.status || 'Unknown error';
      errors++;
    }
    store.put(item);
  }

  await txDone(t);

  // Clean up synced items older than 1 hour
  await cleanSyncedItems();

  return { pushed, errors };
}

async function cleanSyncedItems(): Promise<void> {
  const db = await initDB();
  const t = tx(db, 'sync_queue', 'readwrite');
  const store = t.objectStore('sync_queue');
  const idx = store.index('synced');

  const synced = await reqToPromise(idx.getAll(IDBKeyRange.only(1)));
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  for (const item of synced) {
    if (item.checked_in_at < oneHourAgo) {
      store.delete(item.id);
    }
  }

  await txDone(t);
}

// ── Sync status ────────────────────────────────────────────────────────────

export type SyncStatus = {
  lastSync: string | null;
  ticketCount: number;
  pendingCount: number;
};

export async function getSyncStatus(): Promise<SyncStatus> {
  const [lastSync, ticketCount, pendingCount] = await Promise.all([
    getMeta('last_sync') as Promise<string | null>,
    getMeta('ticket_count').then(v => (typeof v === 'number' ? v : 0)),
    getPendingSyncCount(),
  ]);
  return { lastSync, ticketCount, pendingCount };
}
