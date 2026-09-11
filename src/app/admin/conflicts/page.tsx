'use client';

import { useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';

type Conflict = {
  id: string;
  ticket_uid: string;
  customer_name: string;
  package_name: string;
  booking_ref: string;
  first_scan_at: string;
  first_device_id: string;
  conflict_scan_at: string;
  conflict_device_id: string;
  resolved: boolean;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
};

export default function ConflictsPage() {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const loadConflicts = async () => {
    try {
      setLoading(true);
      setError('');
      const session = (await supabaseBrowser.auth.getSession()).data.session;
      if (!session) throw new Error('Staff session has expired');

      const params = new URLSearchParams({ date: selectedDate });
      if (showResolved) params.set('resolved', 'true');

      const response = await fetch(`/api/admin/conflicts?${params}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load conflicts');

      setConflicts(data.conflicts || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conflicts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConflicts();
  }, [selectedDate, showResolved]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveConflict = async (id: string, notes?: string) => {
    try {
      setResolving(id);
      const session = (await supabaseBrowser.auth.getSession()).data.session;
      if (!session) throw new Error('Staff session has expired');

      const response = await fetch('/api/admin/conflicts', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, notes }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Could not resolve conflict');
      }

      // Reload
      await loadConflicts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve conflict');
    } finally {
      setResolving(null);
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const shortDevice = (id: string) => id.slice(0, 8) + '…';

  return (
    <main className="container" style={{ padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '2rem' }}>
        <div>
          <p style={{ color: 'var(--primary)', fontWeight: 700 }}>STAFF OPERATIONS</p>
          <h1 style={{ fontSize: '2rem' }}>Duplicate Check-in Alerts</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 4 }}>
            These tickets were scanned on multiple offline devices before sync.
          </p>
        </div>
        <a className="btn" href="/admin" style={{ border: '1px solid var(--border-color)' }}>← Dashboard</a>
      </div>

      {/* Controls */}
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          style={{ padding: '0.7rem', border: '1px solid var(--border-color)', borderRadius: 8, fontWeight: 700 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showResolved}
            onChange={e => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
        <button className="btn" onClick={loadConflicts} style={{ border: '1px solid var(--border-color)' }}>
          Refresh
        </button>
      </div>

      {error && <div className="card" style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div className="card">Loading conflicts…</div>
      ) : conflicts.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem' }}>
          <p style={{ fontSize: '2rem', marginBottom: 8 }}>✅</p>
          <p style={{ fontWeight: 700 }}>No duplicate check-in alerts</p>
          <p>All scans for {selectedDate} are clean.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {conflicts.map(conflict => (
            <div
              key={conflict.id}
              className="card"
              style={{
                borderLeft: `4px solid ${conflict.resolved ? 'var(--success)' : 'var(--danger)'}`,
                opacity: conflict.resolved ? 0.7 : 1,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>{conflict.customer_name}</h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    {conflict.ticket_uid} · {conflict.package_name} · {conflict.booking_ref}
                  </p>
                </div>
                {conflict.resolved && (
                  <span style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: 'rgba(16, 185, 129, 0.1)',
                    color: 'var(--success)',
                    fontWeight: 700,
                    fontSize: '0.8rem',
                  }}>
                    RESOLVED
                  </span>
                )}
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '1rem',
                marginTop: '1rem',
                padding: '0.75rem',
                background: 'var(--bg-color)',
                borderRadius: 8,
              }}>
                <div>
                  <p style={{ color: 'var(--success)', fontWeight: 700, fontSize: '0.8rem', marginBottom: 4 }}>FIRST SCAN ✓</p>
                  <p>{formatTime(conflict.first_scan_at)}</p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Device: {shortDevice(conflict.first_device_id)}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--danger)', fontWeight: 700, fontSize: '0.8rem', marginBottom: 4 }}>CONFLICT SCAN ⚠</p>
                  <p>{formatTime(conflict.conflict_scan_at)}</p>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Device: {shortDevice(conflict.conflict_device_id)}</p>
                </div>
              </div>

              {conflict.notes && (
                <p style={{ marginTop: 8, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  Note: {conflict.notes}
                </p>
              )}

              {!conflict.resolved && (
                <div style={{ marginTop: '0.75rem', display: 'flex', gap: 8 }}>
                  <button
                    className="btn"
                    onClick={() => resolveConflict(conflict.id)}
                    disabled={resolving === conflict.id}
                    style={{
                      background: 'var(--success)',
                      color: 'white',
                      opacity: resolving === conflict.id ? 0.6 : 1,
                    }}
                  >
                    {resolving === conflict.id ? 'Resolving…' : 'Mark as resolved'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      const note = prompt('Add a note about this conflict (optional):');
                      if (note !== null) resolveConflict(conflict.id, note || undefined);
                    }}
                    style={{ border: '1px solid var(--border-color)' }}
                  >
                    Resolve with note
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
